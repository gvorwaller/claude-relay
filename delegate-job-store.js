'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const DAY_MS = 24 * 60 * 60 * 1000;

// spawned → running → completed | failed | interrupted → reported
//
// `reported` is TERMINAL for the baseline: a Stop hook proved the receipt was
// included in a completed assistant message. It deliberately does NOT mean a
// client rendered it — that would be `surfaced`, which only exists if a real
// client acknowledgement channel is ever built.
const TRANSITIONS = {
  // 'completed' is reachable straight from 'spawned': a wake process can
  // exit cleanly without its delegate ever registering (it had nothing to
  // do, or it never got that far). That is still a terminal outcome the
  // human is owed — an empty `outbound` list tells the real story.
  spawned: ['running', 'completed', 'failed', 'interrupted'],
  running: ['completed', 'failed', 'interrupted'],
  completed: ['reported'],
  failed: ['reported'],
  interrupted: ['reported'],
  reported: ['surfaced'],
  surfaced: []
};
const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'interrupted']);

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
    this.jobs = new Map();
  }

  initialize() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dataDir, 0o700);
    for (const file of this.jobFiles()) {
      try {
        const job = JSON.parse(fs.readFileSync(file.path, 'utf8'));
        if (job && job.jobId) this.jobs.set(job.jobId, job);
      } catch {
        // A crash can leave one partial file; the rest of the store stands.
        this.logger.warn('job_record_unreadable', { path: file.path });
      }
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
      const alive = job.spawnPid ? this.pidAlive(job.spawnPid) : false;
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

  pidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  }

  create({ owner, inboundMessageId, from }) {
    const job = {
      jobId: `wake_${randomUUID()}`,
      owner,
      inboundMessageId: inboundMessageId || null,
      from: from || null,
      status: 'spawned',
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
      // Server-attested outbound sends. The delegate cannot write here.
      outbound: []
    };
    this.jobs.set(job.jobId, job);
    this.persist(job);
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
      Object.assign(job, patch);
      this.persist(job);
      return job; // idempotent
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
    job.outbound.push({
      to,
      messageId,
      delivered: Boolean(delivered),
      at: new Date(this.now()).toISOString()
    });
    this.persist(job);
    return job;
  }

  /** Terminal-but-unreported jobs for an owner, oldest first. */
  pending(owner) {
    return Array.from(this.jobs.values())
      .filter(job => job.owner === owner && TERMINAL_RUN_STATES.has(job.status))
      .sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)));
  }

  markReported(jobIds, turnId) {
    const marked = [];
    for (const jobId of jobIds) {
      const job = this.transition(jobId, 'reported', { reportedTurnId: turnId || null });
      if (job) marked.push(job.jobId);
    }
    return marked;
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

  prune() {
    const cutoff = this.now() - this.retentionDays * DAY_MS;
    for (const job of Array.from(this.jobs.values())) {
      const at = Date.parse(job.completedAt || job.requestedAt || '');
      // Never prune a job the human has not been told about yet.
      const unreported = TERMINAL_RUN_STATES.has(job.status);
      if (Number.isFinite(at) && at < cutoff && !unreported) this.remove(job.jobId);
    }
    const files = this.jobFiles();
    let excess = files.length - this.maxJobs;
    for (const file of files) {
      if (excess <= 0) break;
      const jobId = path.basename(file.path, '.json');
      const job = this.jobs.get(jobId);
      if (job && TERMINAL_RUN_STATES.has(job.status)) continue; // keep unreported
      this.remove(jobId);
      excess -= 1;
    }
  }

  remove(jobId) {
    this.jobs.delete(jobId);
    try { fs.unlinkSync(path.join(this.dataDir, `${jobId}.json`)); } catch {}
  }
}

module.exports = { DelegateJobStore, TRANSITIONS, TERMINAL_RUN_STATES };
