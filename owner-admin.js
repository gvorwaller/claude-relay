'use strict';

const fs = require('fs');
const path = require('path');
const { randomBytes, createHash, timingSafeEqual } = require('crypto');

const LABEL_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function readOrCreateAdminSecret(filePath) {
  try {
    const secret = fs.readFileSync(filePath, 'utf8').trim();
    if (!secret) throw new Error('Admin capability file is empty');
    fs.chmodSync(filePath, 0o600);
    return secret;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString('base64url');
  fs.writeFileSync(filePath, secret, { mode: 0o600, flag: 'wx' });
  return secret;
}

function verifySecret(expected, supplied) {
  if (typeof supplied !== 'string' || !supplied) return false;
  const a = sha256(expected);
  const b = sha256(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

function writeSecretAtomic(target, secret) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, secret, { mode: 0o600 });
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o600);
}

class OwnerAdmin {
  constructor(options) {
    this.capabilities = options.capabilities;
    this.dataDir = options.dataDir;
    this.ownerDir = options.ownerDir;
    this.logger = options.logger || { info() {}, warn() {}, error() {} };
    this.journalDir = path.join(this.dataDir, 'owner-rotations');
  }

  secretPath(label) {
    return path.join(this.ownerDir, `${label}.secret`);
  }

  journalPath(label) {
    return path.join(this.journalDir, `${label}.json`);
  }

  rotate(label, options = {}) {
    if (!LABEL_PATTERN.test(label) || label.toLowerCase() === 'all') {
      throw new Error('Invalid owner label');
    }
    const secret = options.secret || randomBytes(32).toString('base64url');
    const journal = this.journalPath(label);
    fs.mkdirSync(this.journalDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(journal, JSON.stringify({ label, secret, host: options.host || null }), {
      mode: 0o600,
      flag: 'wx'
    });
    try {
      const result = this.capabilities.mintOwner(label, { host: options.host || null, secret });
      writeSecretAtomic(this.secretPath(label), secret);
      fs.unlinkSync(journal);
      this.logger.warn('owner_capability_rotated', { label, generation: result.generation });
      return { label, generation: result.generation, secretPath: this.secretPath(label) };
    } catch (err) {
      // Leave the 0600 journal for deterministic startup recovery. It contains
      // exactly the replacement secret, never an old credential.
      this.logger.error('owner_rotation_incomplete', { label, error: err.message });
      throw err;
    }
  }

  recover() {
    let names = [];
    try { names = fs.readdirSync(this.journalDir).filter(name => name.endsWith('.json')); } catch {}
    const recovered = [];
    for (const name of names) {
      const journal = path.join(this.journalDir, name);
      try {
        const record = JSON.parse(fs.readFileSync(journal, 'utf8'));
        if (!record || !LABEL_PATTERN.test(record.label) || typeof record.secret !== 'string') {
          throw new Error('invalid rotation journal');
        }
        const result = this.capabilities.mintOwner(record.label, {
          host: record.host || null,
          secret: record.secret
        });
        writeSecretAtomic(this.secretPath(record.label), record.secret);
        fs.unlinkSync(journal);
        recovered.push({ label: record.label, generation: result.generation });
        this.logger.warn('owner_rotation_recovered', { label: record.label, generation: result.generation });
      } catch (err) {
        this.logger.error('owner_rotation_recovery_failed', { journal, error: err.message });
      }
    }
    return recovered;
  }
}

module.exports = {
  OwnerAdmin, LABEL_PATTERN, readOrCreateAdminSecret, verifySecret, writeSecretAtomic
};
