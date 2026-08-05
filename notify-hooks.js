'use strict';

const fs = require('fs');
const { spawn } = require('child_process');

const EXEC_TIMEOUT_MS = 30000;

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
    this.runner = options.runner || this.defaultRunner.bind(this);
    this.now = options.now || (() => Date.now());
    // Debounce state per config entry: `${configKey}:${entryIndex}` -> last-fired ms
    this.lastFired = new Map();
    // Suppressed fires that MUST still happen: `key` -> pending timer. A
    // debounced message with no later trigger would otherwise sit unread
    // forever (2026-08-05 review finding #4), so suppression always schedules
    // a trailing-edge fire for the newest suppressed context.
    this.pendingTrailing = new Map();
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
      this.runner(entry, { target: job.target, from: context.from, messageId: context.messageId, delivered });
      // Committed only AFTER the runner succeeds: a failed spawn must not
      // start a debounce window that suppresses the retry.
      this.lastFired.set(key, this.now());
      this.logger.info('notify_hook_fired', { target: job.target, kind: entry.type, from: context.from });
    } catch (err) {
      this.logger.warn('notify_hook_failed', { target: job.target, kind: entry.type, error: err.message });
    }
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

  defaultRunner(entry, { target, from, messageId, delivered }) {
    if (entry.type === 'banner') {
      const title = `${entry.titlePrefix || 'relay'}: ${target}`;
      const body = `New message from ${from}`;
      spawn('osascript', [
        '-e',
        `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`
      ], { detached: true, stdio: 'ignore' }).unref();
    } else if (entry.type === 'exec' && typeof entry.command === 'string' && entry.command.trim()) {
      const child = spawn(entry.command, {
        shell: true,
        detached: true,
        stdio: 'ignore',
        timeout: EXEC_TIMEOUT_MS,
        env: {
          ...process.env,
          RELAY_FOR: target,
          RELAY_FROM: from,
          RELAY_MESSAGE_ID: messageId || '',
          RELAY_DELIVERED: delivered ? '1' : '0'
        }
      });
      child.on('error', err =>
        this.logger.warn('notify_exec_error', { target, error: err.message }));
      child.unref();
    }
  }
}

module.exports = { NotifyHooks };
