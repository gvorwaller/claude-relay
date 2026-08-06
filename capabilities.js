'use strict';

const fs = require('fs');
const path = require('path');
const { randomBytes, createHash, timingSafeEqual } = require('crypto');

const JOB_TOKEN_TTL_MS = 10 * 60 * 1000;      // window to CONSUME the token
const JOB_SESSION_MAX_MS = 60 * 60 * 1000;    // max lifetime of the delegate session

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Server-side credentials for the relay's two trust decisions.
 *
 *   Owner capability — long-lived, per label. Proves "this process is the
 *   session that owns CODEX3" without trusting a client-asserted pid (which
 *   is forgeable). Generation-versioned so rotation revokes everything
 *   derived from it. `acknowledged` records that a client has actually
 *   *used* the capability, which is how migration self-heals: once a label
 *   has been claimed with its secret, that label stops accepting
 *   secret-less claims forever.
 *
 *   Job capability — single-use, short-lived, minted by the notify path when
 *   it spawns a wake, and bound to the spawned process tree. Proves "the
 *   relay server started me for job X on behalf of CODEX3".
 *
 * Only hashes are persisted. A corrupt or unreadable store fails CLOSED:
 * treating it as empty would let the next claimant re-enroll every label.
 */
class CapabilityStore {
  constructor(options = {}) {
    this.filePath = options.filePath
      || path.join(options.dataDir || path.join(__dirname, 'data'), 'owners.json');
    this.logger = options.logger || { info() {}, warn() {}, error() {} };
    this.now = options.now || (() => Date.now());
    this.jobTtlMs = options.jobTtlMs || JOB_TOKEN_TTL_MS;
    this.jobSessionMaxMs = options.jobSessionMaxMs || JOB_SESSION_MAX_MS;
    this.owners = this.load();
    // Job tokens are deliberately in-memory: a server restart invalidates
    // outstanding wakes, and a delegate that cannot authenticate fails closed.
    this.jobs = new Map();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      // Only "no file yet" may mean "no owners yet".
      if (err.code === 'ENOENT') return Object.create(null);
      throw new Error(`Owner capability store unreadable (${err.code}): ${this.filePath}. `
        + 'Refusing to start with unknown ownership state.');
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Owner capability store is corrupt: ${this.filePath}. `
        + 'Move it aside deliberately to reset ownership; refusing to fail open.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Owner capability store has an invalid shape: ${this.filePath}`);
    }
    // Null-prototype: a label like "constructor" or "toString" must not read
    // as already-enrolled via the prototype chain.
    const owners = Object.create(null);
    for (const [label, record] of Object.entries(parsed)) {
      const invalid = !record
        || typeof record !== 'object'
        || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(label)
        || typeof record.hash !== 'string' || !/^[0-9a-f]{64}$/.test(record.hash)
        || !Number.isInteger(record.generation) || record.generation < 1
        || (record.acknowledged !== undefined && typeof record.acknowledged !== 'boolean')
        || (record.createdAt !== undefined
          && (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))))
        || (record.host !== undefined && record.host !== null && typeof record.host !== 'string');
      if (invalid) {
        throw new Error(`Owner capability store has an invalid record for "${label}": ${this.filePath}`);
      }
      owners[label] = { acknowledged: false, ...record };
    }
    return owners;
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
    // Durability of the rename itself.
    try {
      const dirFd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch { /* not all platforms permit directory fsync */ }
  }

  hasOwner(label) {
    return Object.prototype.hasOwnProperty.call(this.owners, label);
  }

  /** True once a client has successfully authenticated with this capability. */
  isAcknowledged(label) {
    return this.hasOwner(label) && this.owners[label].acknowledged === true;
  }

  /**
   * Drop never-acknowledged records older than the retention window. Every
   * transient client (watchers, one-off tools) enrolls a label, so without
   * this the store grows without bound. Acknowledged owners are never pruned.
   */
  pruneUnacknowledged(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    const cutoff = this.now() - maxAgeMs;
    let removed = 0;
    for (const label of Object.keys(this.owners)) {
      const record = this.owners[label];
      if (record.acknowledged) continue;
      const created = Date.parse(record.createdAt || '');
      if (Number.isFinite(created) && created < cutoff) {
        delete this.owners[label];
        removed += 1;
      }
    }
    if (removed) {
      this.persist();
      this.logger.info('owner_capabilities_pruned', { removed });
    }
    return removed;
  }

  /** Mint (or rotate) the owner capability for a label. Returns plaintext once. */
  mintOwner(label, { host = null } = {}) {
    this.pruneUnacknowledged();
    const secret = randomBytes(32).toString('base64url');
    const previous = this.hasOwner(label) ? this.owners[label] : null;
    this.owners[label] = {
      hash: sha256(secret),
      generation: (previous ? previous.generation : 0) + 1,
      createdAt: new Date(this.now()).toISOString(),
      acknowledged: false,
      host
    };
    this.persist();
    this.revokeJobsFor(label);
    this.logger.info('owner_capability_minted', {
      label,
      generation: this.owners[label].generation
    });
    return { secret, generation: this.owners[label].generation };
  }

  verifyOwner(label, secret) {
    if (!this.hasOwner(label)) return false;
    const record = this.owners[label];
    if (typeof secret !== 'string' || !secret) return false;
    const provided = Buffer.from(sha256(secret), 'hex');
    const stored = Buffer.from(record.hash, 'hex');
    if (provided.length !== stored.length) return false;
    if (!timingSafeEqual(provided, stored)) return false;
    if (!record.acknowledged) {
      // First successful use closes the migration window for this label.
      record.acknowledged = true;
      this.persist();
      this.logger.info('owner_capability_acknowledged', { label });
    }
    return true;
  }

  ownerGeneration(label) {
    return this.hasOwner(label) ? this.owners[label].generation : 0;
  }

  /**
   * Single-use capability for one delegated wake. `replyTo` scopes what the
   * delegate may do; `spawnPid` is filled in after the wake process starts so
   * registration can require the connection to come from that process tree.
   */
  mintJob({ owner, messageId, replyTo }) {
    this.pruneJobs();
    const token = randomBytes(32).toString('base64url');
    const key = sha256(token);
    const job = {
      owner,
      messageId: messageId || null,
      replyTo: replyTo || null,
      generation: this.ownerGeneration(owner),
      expiresAt: this.now() + this.jobTtlMs,
      sessionExpiresAt: this.now() + this.jobSessionMaxMs,
      spawnPid: null
    };
    this.jobs.set(key, job);
    return { token, key, job };
  }

  setJobSpawnPid(key, pid) {
    const job = this.jobs.get(key);
    if (job) job.spawnPid = pid;
  }

  revokeJobByKey(key) {
    this.jobs.delete(key);
  }

  /** Cheap non-consuming existence check (used to reject junk before doing
   * any expensive verification work). */
  hasJob(token) {
    if (typeof token !== 'string' || !token) return false;
    return this.jobs.has(sha256(token));
  }

  /**
   * Authorize AND consume in one step. Every factor is checked before the
   * token is spent: a failed attempt (wrong owner, expired, failing the
   * caller's extra check) must not burn the capability, or an attacker could
   * deny the real delegate simply by trying once (re-check #2).
   *
   * `verify` receives the job and returns true to accept.
   */
  authorizeJob(token, owner, verify = () => true) {
    this.pruneJobs();
    if (typeof token !== 'string' || !token) return { ok: false, reason: 'missing' };
    const key = sha256(token);
    const job = this.jobs.get(key);
    if (!job) return { ok: false, reason: 'unknown' };
    if (job.owner !== owner) return { ok: false, reason: 'owner-mismatch' };
    if (job.expiresAt <= this.now()) {
      this.jobs.delete(key);
      return { ok: false, reason: 'expired' };
    }
    if (job.generation !== this.ownerGeneration(owner)) {
      this.jobs.delete(key);
      return { ok: false, reason: 'revoked' };
    }
    if (!verify(job)) return { ok: false, reason: 'verification-failed', job };
    this.jobs.delete(key); // spent only on success
    return { ok: true, job };
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
