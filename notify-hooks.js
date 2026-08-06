'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');

const EXEC_TIMEOUT_MS = 30000;
// A nonzero exit sooner than this means the command never really ran
// (missing binary -> shell exits 127, bad flags, etc).
const EARLY_EXIT_MS = 5000;

/**
 * Server-side wake hooks, consulted after a message is stored.
 *
 * Config lives in data/notify.json (operator-owned, same trust level as the
 * launchd plist — deliberately NOT settable over the protocol). Shape:
 *
 *   {
 *     "CODEX3": [
 *       { "type": "banner", "titlePrefix": "relay" },
 *       { "type": "exec", "command": "codex exec resume --last '...'",
 *         "debounceSeconds": 300 }
 *     ],
 *     "*": [ { "type": "banner", "onlyIfUndelivered": true } ]
 *   }
 *
 * Semantics:
 * - Direct message to X fires entries under "X" and "*" (RELAY_FOR=X).
 * - Broadcast fires each named key except the sender, plus "*" once with
 *   RELAY_FOR=all.
 * - Notifications stay content-free: hooks see sender, target, and message id,
 *   never the message body.
 * - Hook failures are logged and never touch the message path.
 */
class NotifyHooks {
  constructor(options = {}) {
    this.configPath = options.configPath;
    this.logger = options.logger || { info() {}, warn() {}, error() {} };
    // Mints the single-use job capability each delegated wake must present.
    this.capabilities = options.capabilities || null;
    // Durable record of every delegated wake (accountability layer).
    this.jobStore = options.jobStore || null;
    this.runner = options.runner || this.defaultRunner.bind(this);
    this.now = options.now || (() => Date.now());
    // Debounce state per config entry: `${configKey}:${entryIndex}` -> last-fired ms
    this.lastFired = new Map();
    // Suppressed fires that MUST still happen: `key` -> pending timer. A
    // debounced message with no later trigger would otherwise sit unread
    // forever (2026-08-05 review finding #4), so suppression always schedules
    // a trailing-edge fire for the newest suppressed context.
    this.pendingTrailing = new Map();
    // Retry bookkeeping for wakes whose command failed to actually run.
    this.retryCounts = new Map();
    this.maxRetries = options.maxRetries === undefined ? 3 : options.maxRetries;
    this.retryDelayMs = options.retryDelayMs === undefined ? 2000 : options.retryDelayMs;
    this.configCache = { mtimeMs: -1, entries: null };
  }

  // Reload on mtime change so the operator can edit notify.json without a
  // server restart. Absent or invalid config disables hooks, nothing more.
  loadConfig() {
    let stat;
    try {
      stat = fs.statSync(this.configPath);
    } catch {
      this.configCache = { mtimeMs: -1, entries: null };
      return null;
    }
    if (this.configCache.entries && stat.mtimeMs === this.configCache.mtimeMs) {
      return this.configCache.entries;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      const entries = parsed && typeof parsed === 'object' ? parsed : null;
      this.configCache = { mtimeMs: stat.mtimeMs, entries };
      return entries;
    } catch (err) {
      this.logger.warn('notify_config_invalid', { path: this.configPath, error: err.message });
      this.configCache = { mtimeMs: stat.mtimeMs, entries: null };
      return null;
    }
  }

  fire({ to, from, messageId, delivered, deliveredToDelegate }) {
    try {
      const config = this.loadConfig();
      if (!config) return;
      const jobs = [];
      if (to === 'all') {
        for (const key of Object.keys(config)) {
          if (key === '*' || key === from) continue;
          jobs.push({ key, target: key });
        }
        if (config['*']) jobs.push({ key: '*', target: 'all' });
      } else {
        if (config[to]) jobs.push({ key: to, target: to });
        if (config['*']) jobs.push({ key: '*', target: to });
      }
      for (const job of jobs) {
        const entries = Array.isArray(config[job.key]) ? config[job.key] : [];
        entries.forEach((entry, index) =>
          this.fireEntry(entry, index, job, { from, messageId, delivered, deliveredToDelegate }));
      }
    } catch (err) {
      this.logger.error('notify_fire_failed', { error: err.message });
    }
  }

  fireEntry(entry, index, job, context) {
    const { delivered, deliveredToDelegate } = context;
    if (!entry || typeof entry !== 'object') return;
    if (entry.onlyIfUndelivered && delivered) return;
    const debounceMs = Math.max(0, Number(entry.debounceSeconds) || 0) * 1000;
    // Keyed per TARGET, not just per config entry: a wildcard entry serving
    // many peers must not let one peer's wake swallow another's.
    const key = `${job.key}:${index}:${job.target}`;
    // Suppression NEVER simply drops a wake — the suppressed message may be
    // the last one for hours. Both suppression reasons get a trailing-edge
    // fire instead: a delegate that was live at arrival may exit without
    // reading this message, and a debounced message needs a wake once the
    // window closes.
    if (entry.type === 'exec' && job.target === 'all') {
      // "Wake everyone" has no owner to attribute a job to; concrete targets
      // already get their own entries (re-check #11).
      this.logger.info('notify_exec_skipped_broadcast', { from: context.from });
      return;
    }
    if (entry.type === 'exec' && deliveredToDelegate) {
      this.scheduleTrailing(key, entry, index, job, context, debounceMs || 15000);
      return;
    }
    const now = this.now();
    if (debounceMs > 0 && now - (this.lastFired.get(key) || 0) < debounceMs) {
      const remaining = (this.lastFired.get(key) || 0) + debounceMs - now;
      this.scheduleTrailing(key, entry, index, job, context, Math.max(remaining, 50));
      return;
    }
    const pending = this.pendingTrailing.get(key);
    if (pending) {
      clearTimeout(pending);
      this.pendingTrailing.delete(key);
    }
    try {
      this.runner(
        entry,
        { target: job.target, from: context.from, messageId: context.messageId, delivered },
        // Asynchronous outcome. With `shell: true` a missing command spawns
        // the shell fine and exits 127 later, so synchronous success proves
        // nothing (review re-check #6): a wake that never really ran must
        // release its debounce window and retry.
        outcome => this.handleRunnerOutcome(outcome, key, entry, index, job, context)
      );
      this.lastFired.set(key, this.now());
      this.logger.info('notify_hook_fired', { target: job.target, kind: entry.type, from: context.from });
    } catch (err) {
      this.lastFired.delete(key);
      this.logger.warn('notify_hook_failed', { target: job.target, kind: entry.type, error: err.message });
      this.scheduleRetry(key, entry, index, job, context, 'threw');
    }
  }

  handleRunnerOutcome(outcome, key, entry, index, job, context) {
    if (!outcome || outcome.ok !== false) {
      this.retryCounts.delete(key);
      return;
    }
    this.lastFired.delete(key);
    this.logger.warn('notify_hook_run_failed', {
      target: job.target,
      kind: entry.type,
      error: outcome.error || null,
      exitCode: outcome.code === undefined ? null : outcome.code
    });
    this.scheduleRetry(key, entry, index, job, context, outcome.error || `exit ${outcome.code}`);
  }

  scheduleRetry(key, entry, index, job, context, reason) {
    const attempts = (this.retryCounts.get(key) || 0) + 1;
    if (attempts > this.maxRetries) {
      // Permanently broken command: stop retrying, but say so loudly rather
      // than leaving a wake silently undelivered.
      this.logger.error('notify_hook_giving_up', { target: job.target, kind: entry.type, attempts, reason });
      this.retryCounts.delete(key);
      return;
    }
    this.retryCounts.set(key, attempts);
    this.scheduleTrailing(key, entry, index, job, context, this.retryDelayMs * attempts);
  }

  scheduleTrailing(key, entry, index, job, context, delayMs) {
    const existing = this.pendingTrailing.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pendingTrailing.delete(key);
      // Re-enter with delegate suppression cleared (the delegate that caused
      // it is likely gone; a redundant wake is a cheap no-op, a missing wake
      // is stranded mail). The debounce window is re-checked naturally.
      this.fireEntry(entry, index, job, { ...context, deliveredToDelegate: false });
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.pendingTrailing.set(key, timer);
    this.logger.info('notify_hook_deferred', { target: job.target, kind: entry.type, delayMs });
  }

  defaultRunner(entry, { target, from, messageId, delivered }, onOutcome = () => {}) {
    if (entry.type === 'banner') {
      // Values arrive as argv (`on run argv`), never interpolated into the
      // script source: a hostile target/sender name cannot become AppleScript
      // (review finding #1). The script text below is a fixed constant.
      spawn('osascript', [
        '-e', 'on run argv',
        '-e', 'display notification (item 2 of argv) with title (item 1 of argv)',
        '-e', 'end run',
        `${entry.titlePrefix || 'relay'}: ${target}`,
        `New message from ${from}`
      ], { detached: true, stdio: 'ignore' }).unref();
    } else if (entry.type === 'exec' && typeof entry.command === 'string' && entry.command.trim()) {
      const startedAt = Date.now();
      // The delegate capability is a PREREQUISITE, not a best-effort extra:
      // spawning a wake that cannot authenticate produces a rejected delegate
      // and silently stranded mail (re-check #10). Mint + hand off first; on
      // failure, do not spawn and report failure so the retry path runs.
      let tokenFile = null;
      let jobKey = null;
      let jobRecord = null;
      let resultSecretFile = null;
      if (this.capabilities && target !== 'all') {
        try {
          // The job record exists BEFORE the wake is spawned, so a process
          // that dies immediately still leaves an auditable trace.
          if (this.jobStore) {
            jobRecord = this.jobStore.create({ owner: target, inboundMessageId: messageId, from });
          }
          const { token, key, resultSecret } = this.capabilities.mintJob({
            owner: target,
            messageId,
            replyTo: from,
            jobId: jobRecord ? jobRecord.jobId : null
          });
          jobKey = key;
          if (jobRecord && resultSecret) {
            resultSecretFile = path.join(os.tmpdir(), `relay-result-${randomUUID()}.secret`);
            fs.writeFileSync(resultSecretFile, resultSecret, { mode: 0o600 });
            setTimeout(() => { try { fs.unlinkSync(resultSecretFile); } catch {} },
              this.capabilities.jobSessionMaxMs).unref();
          }
          tokenFile = path.join(os.tmpdir(), `relay-job-${randomUUID()}.token`);
          fs.writeFileSync(tokenFile, token, { mode: 0o600 });
          // Reaped after the consume window, matching the token's own TTL.
          setTimeout(() => { try { fs.unlinkSync(tokenFile); } catch {} }, this.capabilities.jobTtlMs)
            .unref();
        } catch (err) {
          this.logger.error('job_capability_mint_failed', { target, error: err.message });
          if (jobKey) this.capabilities.revokeJobByKey(jobKey);
          if (tokenFile) { try { fs.unlinkSync(tokenFile); } catch {} }
          if (jobRecord && this.jobStore) {
            this.jobStore.transition(jobRecord.jobId, 'failed', {
              reason: `setup failed: ${err.message}`
            });
          }
          onOutcome({ ok: false, error: `job capability unavailable: ${err.message}` });
          return;
        }
      }
      let child;
      try {
        child = spawn(entry.command, {
        shell: true,
        detached: true,
        stdio: 'ignore',
        timeout: EXEC_TIMEOUT_MS,
        env: {
          ...process.env,
          RELAY_FOR: target,
          RELAY_FROM: from,
          RELAY_MESSAGE_ID: messageId || '',
          RELAY_DELIVERED: delivered ? '1' : '0',
          ...(tokenFile ? { RELAY_JOB_TOKEN_FILE: tokenFile } : {}),
          ...(jobRecord ? { RELAY_JOB_ID: jobRecord.jobId } : {}),
          ...(resultSecretFile ? { RELAY_JOB_RESULT_SECRET_FILE: resultSecretFile } : {})
        }
      });
      } catch (err) {
        if (jobKey) this.capabilities.revokeJobByKey(jobKey);
        if (tokenFile) { try { fs.unlinkSync(tokenFile); } catch {} }
        if (jobRecord && this.jobStore) {
          this.jobStore.transition(jobRecord.jobId, 'failed', { reason: `spawn threw: ${err.message}` });
        }
        onOutcome({ ok: false, error: err.message });
        return;
      }
      // Bind the capability to this process tree: registration later requires
      // the connecting bridge to be a descendant of the wake we started.
      if (jobKey && child.pid) this.capabilities.setJobSpawnPid(jobKey, child.pid);
      if (jobRecord && this.jobStore) {
        this.jobStore.transition(jobRecord.jobId, 'spawned', { spawnPid: child.pid || null });
      }
      // 'error' and 'exit' can both fire; the outcome must be reported once.
      let settled = false;
      const settle = outcome => {
        if (settled) return;
        settled = true;
        if (jobRecord && this.jobStore) {
          // outcome.ok answers "should we retry the wake?", NOT "did the
          // work succeed?" (re-check #3). Any nonzero exit is a failure; a
          // clean exit whose delegate never registered gets its own state
          // rather than claiming completion.
          const exitCode = outcome.code === undefined ? null : outcome.code;
          const current = this.jobStore.get(jobRecord.jobId);
          const ranAsDelegate = current && current.status === 'running';
          let terminal;
          if (outcome.error || (exitCode !== null && exitCode !== 0)) {
            terminal = 'failed';
          } else {
            terminal = ranAsDelegate ? 'completed' : 'exited_no_delegate';
          }
          this.jobStore.transition(jobRecord.jobId, terminal, {
            exitCode,
            reason: outcome.error || null
          });
        }
        if (!outcome.ok) {
          // A wake that never really ran must leave nothing usable behind:
          // its capability is revoked and its handoff file removed, so a
          // retry mints a fresh one instead of leaving several live tokens
          // (and stale pid bindings) outstanding.
          if (jobKey) this.capabilities.revokeJobByKey(jobKey);
          if (tokenFile) { try { fs.unlinkSync(tokenFile); } catch {} }
        }
        onOutcome(outcome);
      };
      child.on('error', err => settle({ ok: false, error: err.message }));
      child.on('exit', code => {
        // A wake command legitimately runs long (a resumed agent turn). Only
        // an early nonzero exit means it never really started — that is the
        // shell-127 case a synchronous check cannot see.
        settle(code !== 0 && Date.now() - startedAt < EARLY_EXIT_MS
          ? { ok: false, code }
          : { ok: true, code });
      });
      child.unref();
    }
  }
}

module.exports = { NotifyHooks };
