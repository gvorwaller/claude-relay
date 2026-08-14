'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID, createHash } = require('crypto');

const DAY_MS = 24 * 60 * 60 * 1000;

// spawned → running → completed | failed | interrupted → reported
//
// `reported` is TERMINAL for the baseline: a Stop hook proved the receipt was
// included in a completed assistant message. It deliberately does NOT mean a
// client rendered it — that would be `surfaced`, which only exists if a real
// client acknowledgement channel is ever built.
const TRANSITIONS = {
  // A wake that exits without its delegate ever registering gets its own
  // terminal state: an empty outbound list cannot distinguish "chose to send
  // nothing" from "died before doing anything", and a bare shell exit 0
  // proves no summary, changes, or verification. `completed` stays reserved
  // for a run whose delegate actually connected.
  spawned: ['running', 'exited_no_delegate', 'failed', 'interrupted'],
  running: ['completed', 'failed', 'interrupted'],
  completed: ['reported'],
  exited_no_delegate: ['reported'],
  failed: ['reported'],
  interrupted: ['reported'],
  // `surfaced` intentionally does not exist yet: it would mean a client
  // acknowledged rendering, and no such channel is built.
  reported: []
};
const TERMINAL_RUN_STATES = new Set(['completed', 'exited_no_delegate', 'failed', 'interrupted']);
const ACTIVE_RUN_STATES = new Set(['spawned', 'running']);
const ACTIVITY_TYPES = new Set([
  'analyzing', 'reading_message', 'reading_files', 'running_command',
  'using_tool', 'updating_files', 'sending_reply', 'preparing_response',
  'waiting', 'finishing', 'error'
]);

/**
 * Durable record of every delegated wake: why it started, what it did, what
 * it actually sent (from server evidence, never the delegate's prose), and
 * whether the owning session has since reported it to the human.
 *
 * Control plane only. These records are NOT relay messages: creating or
 * completing one must never fire a notify hook, or a completion would wake
 * the very session it is reporting to.
 */
class DelegateJobStore {
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.join(__dirname, 'data', 'jobs');
    this.logger = options.logger || { info() {}, warn() {}, error() {} };
    this.now = options.now || (() => Date.now());
    this.retentionDays = options.retentionDays || 7;
    this.maxJobs = options.maxJobs || 500;
    this.onCapacity = options.onCapacity || null;
    this.jobs = new Map();
    // Identifies THIS server run; jobs from earlier runs cannot resume.
    this.instanceId = options.instanceId || randomUUID();
  }

  initialize() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dataDir, 0o700);
    for (const file of this.jobFiles()) {
      let job = null;
      try {
        job = JSON.parse(fs.readFileSync(file.path, 'utf8'));
      } catch {
        job = null;
      }
      const expectedId = path.basename(file.path, '.json');
      if (!this.isValidRecord(job) || job.jobId !== expectedId) {
        // Losing an unreported receipt silently is the failure this store
        // exists to prevent: quarantine loudly instead of skipping.
        try {
          fs.renameSync(file.path, `${file.path}.quarantined`);
        } catch { /* best effort */ }
        this.logger.error('job_record_invalid_quarantined', { path: file.path });
        continue;
      }
      if (!Array.isArray(job.activity)) job.activity = [];
      this.jobs.set(job.jobId, job);
    }
    this.recoverOrphans();
    this.prune();
    return this;
  }

  /**
   * Jobs whose process is gone but which never reached a terminal state are
   * `interrupted` — a delegate that vanished is not a success, and it must
   * still surface to the human.
   */
  recoverOrphans() {
    for (const job of this.jobs.values()) {
      if (TERMINAL_RUN_STATES.has(job.status) || job.status === 'reported') continue;
      // A job from a PREVIOUS server instance can never resume: its job
      // capability lived in memory and died with that instance, so the
      // delegate could not authenticate even if its pid were somehow alive.
      // Treating a reused pid as "still running" would strand it forever.
      const sameInstance = job.serverInstance === this.instanceId;
      const alive = sameInstance && job.spawnPid ? this.pidAlive(job.spawnPid) : false;
      if (!alive) {
        job.status = 'interrupted';
        job.completedAt = new Date(this.now()).toISOString();
        job.summary = job.summary || 'The delegate process ended without reporting a result.';
        job.recovered = true;
        this.persist(job);
        this.logger.warn('job_recovered_as_interrupted', { jobId: job.jobId, owner: job.owner });
      }
    }
  }

  // Canonical shape only. jobId is checked against a strict pattern so a
  // crafted value can never steer persist() outside dataDir.
  isValidRecord(job) {
    return Boolean(job)
      && typeof job === 'object'
      && typeof job.jobId === 'string'
      && /^wake_[0-9a-f-]{36}$/.test(job.jobId)
      && typeof job.owner === 'string'
      && Object.prototype.hasOwnProperty.call(TRANSITIONS, job.status)
      && typeof job.requestedAt === 'string'
      && !Number.isNaN(Date.parse(job.requestedAt))
      && Array.isArray(job.outbound);
  }

  pidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  }

  create({ owner, inboundMessageId, from }) {
    this.prune();
    if (this.jobs.size >= this.maxJobs) {
      this.logger.error('job_store_rejecting_new_work', {
        size: this.jobs.size,
        maxJobs: this.maxJobs,
        note: 'operator must report or investigate retained jobs'
      });
      this.notifyCapacity();
      throw new Error(`delegate job store is at capacity (${this.jobs.size}/${this.maxJobs})`);
    }
    const job = {
      jobId: `wake_${randomUUID()}`,
      owner,
      inboundMessageId: inboundMessageId || null,
      from: from || null,
      status: 'spawned',
      serverInstance: this.instanceId,
      requestedAt: new Date(this.now()).toISOString(),
      startedAt: null,
      completedAt: null,
      reportedAt: null,
      reportedTurnId: null,
      delegateId: null,
      spawnPid: null,
      exitCode: null,
      summary: null,
      changes: null,
      verification: [],
      // Sanitized, allowlisted progress only. Raw Codex JSON, reasoning,
      // commands, arguments, output, paths, and message text never enter the
      // durable record read by relay-monitor.
      activity: [],
      // Server-attested outbound sends. The delegate cannot write here.
      outbound: []
    };
    this.jobs.set(job.jobId, job);
    this.persist(job);
    this.prune();
    this.logger.info('job_created', { jobId: job.jobId, owner, inboundMessageId });
    return job;
  }

  get(jobId) {
    return this.jobs.get(jobId) || null;
  }

  /** Idempotent, fail-closed transition. */
  transition(jobId, status, patch = {}) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (job.status === status) {
      // Idempotent, but never rewritable: a replayed ack must not overwrite
      // the turn that actually reported it (re-check #10).
      if (status === 'reported') return job;
      Object.assign(job, patch);
      this.persist(job);
      return job;
    }
    const allowed = TRANSITIONS[job.status] || [];
    if (!allowed.includes(status)) {
      this.logger.warn('job_invalid_transition', { jobId, from: job.status, to: status });
      return null;
    }
    job.status = status;
    if (status === 'running' && !job.startedAt) job.startedAt = new Date(this.now()).toISOString();
    if (TERMINAL_RUN_STATES.has(status)) job.completedAt = new Date(this.now()).toISOString();
    if (status === 'reported') job.reportedAt = new Date(this.now()).toISOString();
    Object.assign(job, patch);
    this.persist(job);
    this.logger.info('job_transition', { jobId, status, owner: job.owner });
    return job;
  }

  /** Record a send the SERVER observed this delegate make. */
  recordOutbound(jobId, { to, messageId, delivered }) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    // A relay send can finish just after the wake child exits: the message is
    // already in the relay's durable journal while the process-exit callback
    // marks the job completed. Keep accepting SERVER evidence until the owner
    // has actually reported the receipt. `reported` remains immutable, so the
    // human can never be told a fact which changes later.
    if (job.status === 'reported') {
      this.logger.warn('job_outbound_after_terminal', { jobId, status: job.status, to });
      return null;
    }
    if (job.outbound.length >= 50) {
      this.logger.warn('job_outbound_capped', { jobId });
      return null;
    }
    job.outbound.push({
      to,
      messageId,
      delivered: Boolean(delivered),
      at: new Date(this.now()).toISOString()
    });
    this.persist(job);
    return job;
  }

  recordActivity(jobId, { type }) {
    const job = this.jobs.get(jobId);
    if (!job || !ACTIVITY_TYPES.has(type)) return null;
    if (job.status !== 'spawned' && job.status !== 'running') return null;
    const previous = job.activity[job.activity.length - 1];
    if (previous && previous.type === type) return job;
    if (job.activity.length >= 100) job.activity.shift();
    job.activity.push({ type, at: new Date(this.now()).toISOString() });
    this.persist(job);
    return job;
  }

  /**
   * Attach the wake wrapper's own account of the run. This is DELEGATE
   * prose: it never moves the state machine and never touches `outbound`,
   * which is the server's evidence. Refused once the job is reported, so a
   * receipt cannot change after the human was told about it.
   */
  attachResult(jobId, { summary, changes, verification }) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (job.status === 'reported') {
      this.logger.warn('job_result_after_report', { jobId });
      return null;
    }
    job.summary = summary || job.summary;
    job.changes = changes || job.changes;
    if (Array.isArray(verification) && verification.length) job.verification = verification;
    job.resultSubmittedAt = new Date(this.now()).toISOString();
    this.persist(job);
    return job;
  }

  /** Terminal-but-unreported jobs for an owner, oldest first. */
  pending(owner) {
    return Array.from(this.jobs.values())
      .filter(job => job.owner === owner && TERMINAL_RUN_STATES.has(job.status))
      .sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)));
  }

  /** Active work for one owner, used as the per-identity single-flight gate. */
  activeForOwner(owner) {
    return Array.from(this.jobs.values())
      .filter(job => job.owner === owner && ACTIVE_RUN_STATES.has(job.status))
      .sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
  }

  markReported(jobIds, turnId) {
    const marked = [];
    for (const jobId of jobIds) {
      const job = this.transition(jobId, 'reported', { reportedTurnId: turnId || null });
      if (job) marked.push(job.jobId);
    }
    return marked;
  }

  stats() {
    return {
      size: this.jobs.size,
      maxJobs: this.maxJobs,
      unreported: Array.from(this.jobs.values()).filter(job => job.status !== 'reported').length,
      atCapacity: this.jobs.size >= this.maxJobs
    };
  }

  terminalSelection(owner = 'all') {
    return Array.from(this.jobs.values())
      .filter(job => owner === 'all' || job.owner === owner)
      .filter(job => TERMINAL_RUN_STATES.has(job.status) || job.status === 'reported')
      .sort((a, b) => a.jobId.localeCompare(b.jobId));
  }

  previewTerminalPurge(owner = 'all') {
    const jobs = this.terminalSelection(owner);
    const byStatus = {};
    const byOwner = {};
    for (const job of jobs) {
      byStatus[job.status] = (byStatus[job.status] || 0) + 1;
      byOwner[job.owner] = (byOwner[job.owner] || 0) + 1;
    }
    const confirmation = createHash('sha256')
      .update(JSON.stringify({ owner, jobIds: jobs.map(job => job.jobId) }))
      .digest('hex');
    return { owner, count: jobs.length, byStatus, byOwner, confirmation };
  }

  purgeTerminal(owner, confirmation) {
    const preview = this.previewTerminalPurge(owner);
    if (!confirmation || confirmation !== preview.confirmation) {
      return { ...preview, purged: 0, confirmed: false };
    }
    let purged = 0;
    for (const job of this.terminalSelection(owner)) {
      if (this.remove(job.jobId)) purged += 1;
    }
    this.logger.warn('delegate_jobs_purged', { owner, count: purged });
    return { ...preview, purged, confirmed: true };
  }

  notifyCapacity() {
    if (this.jobs.size < this.maxJobs || typeof this.onCapacity !== 'function') return;
    try {
      this.onCapacity(this.stats());
    } catch (err) {
      this.logger.error('job_store_capacity_callback_failed', { error: err.message });
    }
  }

  persist(job) {
    const tmp = path.join(this.dataDir, `${job.jobId}.tmp`);
    const target = path.join(this.dataDir, `${job.jobId}.json`);
    const handle = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(handle, JSON.stringify(job, null, 2));
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(tmp, target);
    try {
      const dirFd = fs.openSync(this.dataDir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch { /* directory fsync unsupported */ }
  }

  jobFiles() {
    if (!fs.existsSync(this.dataDir)) return [];
    return fs.readdirSync(this.dataDir)
      .filter(name => name.endsWith('.json'))
      .map(name => {
        const filePath = path.join(this.dataDir, name);
        try {
          return { path: filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
  }

  /**
   * Only REPORTED jobs are ever removed. Anything still running, or finished
   * but not yet told to the human, is retained regardless of age or count —
   * the previous version could delete an in-flight job under maxJobs
   * pressure (re-check #5). If the store fills with unreported work, that is
   * a condition to alert on, not to silently discard.
   */
  prune() {
    const before = this.jobs.size;
    const cutoff = this.now() - this.retentionDays * DAY_MS;
    for (const job of Array.from(this.jobs.values())) {
      if (job.status !== 'reported') continue;
      const at = Date.parse(job.reportedAt || job.completedAt || job.requestedAt || '');
      if (Number.isFinite(at) && at < cutoff) this.remove(job.jobId);
    }
    const removable = Array.from(this.jobs.values())
      .filter(job => job.status === 'reported')
      .sort((a, b) => String(a.reportedAt).localeCompare(String(b.reportedAt)));
    let excess = this.jobs.size - this.maxJobs;
    for (const job of removable) {
      if (excess <= 0) break;
      if (this.remove(job.jobId)) excess -= 1;
    }
    if (this.jobs.size > this.maxJobs) {
      this.logger.error('job_store_over_capacity_unreported', {
        size: this.jobs.size,
        maxJobs: this.maxJobs,
        note: 'unreported jobs are never dropped; investigate why they are not being reported'
      });
    }
    this.notifyCapacity();
    return { removed: before - this.jobs.size, ...this.stats() };
  }

  /**
   * Drop a job that never represented real work (the wake had nothing to do).
   * Distinct from remove(): refuses to discard anything that actually ran or
   * sent something, so it can never be used to hide a real receipt.
   */
  discard(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.outbound.length > 0 || job.status === 'running' || job.delegateId) {
      this.logger.warn('job_discard_refused', { jobId, status: job.status });
      return false;
    }
    if (!this.remove(jobId)) return false;
    this.logger.info('job_discarded_no_work', { jobId, owner: job.owner });
    return true;
  }

  remove(jobId) {
    try {
      fs.unlinkSync(path.join(this.dataDir, `${jobId}.json`));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.logger.error('job_remove_failed', { jobId, error: err.message });
        return false;
      }
    }
    this.jobs.delete(jobId);
    return true;
  }
}

module.exports = { ACTIVE_RUN_STATES, DelegateJobStore, TRANSITIONS, TERMINAL_RUN_STATES };
