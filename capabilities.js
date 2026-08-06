'use strict';

const fs = require('fs');
const path = require('path');
const { randomBytes, createHash, timingSafeEqual } = require('crypto');

const JOB_TOKEN_TTL_MS = 10 * 60 * 1000;

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Server-side credentials for the relay's two trust decisions.
 *
 *   Owner capability — long-lived, per label. Proves "this process is the
 *   session that owns CODEX3" without trusting a client-asserted pid (which
 *   is forgeable: read a pid from get_sessions, quote it back, get reseated).
 *   Generation-versioned so rotation revokes everything derived from it.
 *
 *   Job capability — single-use, short-lived, minted by the notify path when
 *   it spawns a wake. Proves "the relay server started me for job X on behalf
 *   of CODEX3" — the only thing that may register as a delegate. Least
 *   authority: it carries the inbound message id, so the delegate can be
 *   confined to the mail it was woken for.
 *
 * Only hashes are persisted; plaintext exists in the client's own 0600 file
 * and (for job tokens) transiently in a 0600 handoff file.
 */
class CapabilityStore {
  constructor(options = {}) {
    this.filePath = options.filePath
      || path.join(options.dataDir || path.join(__dirname, 'data'), 'owners.json');
    this.logger = options.logger || { info() {}, warn() {}, error() {} };
    this.now = options.now || (() => Date.now());
    this.jobTtlMs = options.jobTtlMs || JOB_TOKEN_TTL_MS;
    this.owners = this.load();
    // Job tokens are deliberately in-memory: a server restart invalidates
    // outstanding wakes, and a delegate that cannot authenticate fails closed
    // rather than registering unauthenticated.
    this.jobs = new Map();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  persist() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    const handle = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(handle, JSON.stringify(this.owners, null, 2));
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(tmp, this.filePath);
    try {
      const dirHandle = fs.opendirSync(dir);
      dirHandle.closeSync();
    } catch { /* directory fsync is best-effort */ }
  }

  hasOwner(label) {
    return Boolean(this.owners[label]);
  }

  /** Mint (or rotate) the owner capability for a label. Returns plaintext once. */
  mintOwner(label, { host = null } = {}) {
    const secret = randomBytes(32).toString('base64url');
    const previous = this.owners[label];
    this.owners[label] = {
      hash: sha256(secret),
      generation: (previous ? previous.generation : 0) + 1,
      createdAt: new Date(this.now()).toISOString(),
      host
    };
    this.persist();
    // Rotation revokes every job capability derived from the old generation.
    this.revokeJobsFor(label);
    this.logger.info('owner_capability_minted', {
      label,
      generation: this.owners[label].generation
    });
    return { secret, generation: this.owners[label].generation };
  }

  verifyOwner(label, secret) {
    const record = this.owners[label];
    if (!record || typeof secret !== 'string' || !secret) return false;
    const provided = Buffer.from(sha256(secret), 'hex');
    const stored = Buffer.from(record.hash, 'hex');
    if (provided.length !== stored.length) return false;
    return timingSafeEqual(provided, stored);
  }

  ownerGeneration(label) {
    return this.owners[label] ? this.owners[label].generation : 0;
  }

  /** Single-use capability for one delegated wake. */
  mintJob({ owner, messageId }) {
    this.pruneJobs();
    const token = randomBytes(32).toString('base64url');
    const job = {
      owner,
      messageId: messageId || null,
      generation: this.ownerGeneration(owner),
      expiresAt: this.now() + this.jobTtlMs
    };
    this.jobs.set(sha256(token), job);
    return { token, ...job };
  }

  /** Atomically consume a job token. Returns the job, or null if invalid. */
  consumeJob(token, owner) {
    this.pruneJobs();
    if (typeof token !== 'string' || !token) return null;
    const key = sha256(token);
    const job = this.jobs.get(key);
    if (!job) return null;
    this.jobs.delete(key); // single use, consumed even on mismatch below
    if (job.owner !== owner) return null;
    if (job.expiresAt <= this.now()) return null;
    if (job.generation !== this.ownerGeneration(owner)) return null;
    return job;
  }

  revokeJobsFor(owner) {
    for (const [key, job] of this.jobs) {
      if (job.owner === owner) this.jobs.delete(key);
    }
  }

  pruneJobs() {
    const now = this.now();
    for (const [key, job] of this.jobs) {
      if (job.expiresAt <= now) this.jobs.delete(key);
    }
  }
}

module.exports = { CapabilityStore, sha256 };
