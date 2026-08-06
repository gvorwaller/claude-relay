const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CapabilityStore } = require('../capabilities');

function store(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-caps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { store: new CapabilityStore({ dataDir: dir, ...options }), dir };
}

test('owner capability verifies only its own secret and survives restart', t => {
  const { store: caps, dir } = store(t);
  assert.equal(caps.hasOwner('CC9'), false);
  const { secret, generation } = caps.mintOwner('CC9');
  assert.equal(generation, 1);
  assert.ok(caps.verifyOwner('CC9', secret));
  assert.equal(caps.verifyOwner('CC9', 'wrong'), false);
  assert.equal(caps.verifyOwner('CC9', ''), false);
  assert.equal(caps.verifyOwner('OTHER', secret), false);

  // Persisted as a hash only, and readable by a fresh instance.
  const raw = fs.readFileSync(path.join(dir, 'owners.json'), 'utf8');
  assert.equal(raw.includes(secret), false, 'plaintext secret must never be persisted');
  const reopened = new CapabilityStore({ dataDir: dir });
  assert.ok(reopened.verifyOwner('CC9', secret));
});

test('rotation invalidates the old secret and every derived job capability', t => {
  const { store: caps } = store(t);
  const first = caps.mintOwner('CODEX9').secret;
  const job = caps.mintJob({ owner: 'CODEX9', messageId: 'm1' });
  const second = caps.mintOwner('CODEX9').secret;

  assert.equal(caps.verifyOwner('CODEX9', first), false, 'old secret revoked');
  assert.ok(caps.verifyOwner('CODEX9', second));
  assert.equal(caps.authorizeJob(job.token, 'CODEX9').job || null, null, 'derived job revoked by rotation');
  assert.equal(caps.ownerGeneration('CODEX9'), 2);
});

test('job capability is single-use, owner-bound, and expiring', t => {
  let clock = 1_000_000;
  const { store: caps } = store(t, { now: () => clock, jobTtlMs: 1000 });
  caps.mintOwner('CODEX9');

  const job = caps.mintJob({ owner: 'CODEX9', messageId: 'm7' });
  assert.equal(caps.authorizeJob(job.token, 'OTHER').ok, false, 'owner-bound');
  // An owner mismatch must not spend it either.
  assert.equal(caps.authorizeJob(job.token, 'CODEX9').ok, true, 'survives a wrong-owner attempt');

  const fresh = caps.mintJob({ owner: 'CODEX9', messageId: 'm8' });
  const consumed = caps.authorizeJob(fresh.token, 'CODEX9').job || null;
  assert.equal(consumed.messageId, 'm8');
  assert.equal(caps.authorizeJob(fresh.token, 'CODEX9').job || null, null, 'single use');

  const expiring = caps.mintJob({ owner: 'CODEX9', messageId: 'm9' });
  clock += 5000;
  assert.equal(caps.authorizeJob(expiring.token, 'CODEX9').job || null, null, 'expired');

  assert.equal(caps.authorizeJob('not-a-token', 'CODEX9').job || null, null);
  assert.equal(caps.authorizeJob(undefined, 'CODEX9').job || null, null);
});

test('corrupt or unreadable capability state fails closed, never empty', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-caps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'owners.json');

  fs.writeFileSync(file, 'not json');
  assert.throws(() => new CapabilityStore({ dataDir: dir }), /corrupt/);

  fs.writeFileSync(file, JSON.stringify(['array', 'not', 'object']));
  assert.throws(() => new CapabilityStore({ dataDir: dir }), /invalid shape/);

  fs.writeFileSync(file, JSON.stringify({ CC1: { generation: 1 } }));
  assert.throws(() => new CapabilityStore({ dataDir: dir }), /invalid record/);

  // Absent file is the ONLY case that legitimately means "no owners yet".
  fs.unlinkSync(file);
  assert.doesNotThrow(() => new CapabilityStore({ dataDir: dir }));
});

test('prototype-named labels are not treated as enrolled', t => {
  const { store: caps } = store(t);
  for (const label of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(caps.hasOwner(label), false, `${label} must not appear enrolled`);
    assert.equal(caps.verifyOwner(label, 'anything'), false);
  }
  const { secret } = caps.mintOwner('constructor');
  assert.equal(caps.hasOwner('constructor'), true);
  assert.ok(caps.verifyOwner('constructor', secret));
});

test('first successful use marks the capability acknowledged (migration closes)', t => {
  const { store: caps } = store(t);
  const { secret } = caps.mintOwner('CCM');
  assert.equal(caps.isAcknowledged('CCM'), false, 'tolerance available before first use');
  assert.ok(caps.verifyOwner('CCM', secret));
  assert.equal(caps.isAcknowledged('CCM'), true, 'tolerance closes permanently after first use');

  // And it survives a restart.
  const reopened = new CapabilityStore({ dataDir: path.dirname(caps.filePath) });
  assert.equal(reopened.isAcknowledged('CCM'), true);
});

test('job capability carries reply scope, spawn binding, and a session lease', t => {
  const { store: caps } = store(t);
  caps.mintOwner('CODEXJ');
  const { token, key, job } = caps.mintJob({ owner: 'CODEXJ', messageId: 'm1', replyTo: 'CC6' });
  assert.equal(job.replyTo, 'CC6');
  assert.ok(job.sessionExpiresAt > job.expiresAt, 'session lease outlives the consume window');
  caps.setJobSpawnPid(key, 4242);
  const consumed = caps.authorizeJob(token, 'CODEXJ').job;
  assert.equal(consumed.spawnPid, 4242);
  assert.equal(consumed.replyTo, 'CC6');

  // Revocation before consumption.
  const second = caps.mintJob({ owner: 'CODEXJ', messageId: 'm2', replyTo: 'CC6' });
  caps.revokeJobByKey(second.key);
  assert.equal(caps.authorizeJob(second.token, 'CODEXJ').job || null, null);
});

test('a failed authorization does not burn the capability', t => {
  const { store: caps } = store(t);
  caps.mintOwner('CODEXB');
  const { token } = caps.mintJob({ owner: 'CODEXB', messageId: 'm1', replyTo: 'CC6' });

  // A thief fails the extra verification (e.g. wrong process tree)...
  const attacked = caps.authorizeJob(token, 'CODEXB', () => false);
  assert.equal(attacked.ok, false);
  assert.equal(attacked.reason, 'verification-failed');

  // ...and the real delegate can still use it. Burning it here would let an
  // attacker deny the wake with a single failed attempt.
  const real = caps.authorizeJob(token, 'CODEXB', () => true);
  assert.equal(real.ok, true);
  assert.equal(real.job.replyTo, 'CC6');

  // Now it is spent.
  assert.equal(caps.authorizeJob(token, 'CODEXB').ok, false);
});

test('result secrets are single-use, job-bound, and expiring', t => {
  let clock = 2_000_000;
  const { store: caps } = store(t, { now: () => clock, jobSessionMaxMs: 1000 });
  caps.mintOwner('CODEXR');
  const minted = caps.mintJob({ owner: 'CODEXR', messageId: 'm1', replyTo: 'CC6', jobId: 'wake_a' });
  assert.ok(minted.resultSecret, 'a result credential is issued with the job');

  assert.equal(caps.verifyResultSecret('wake_b', minted.resultSecret), false, 'job-bound');
  assert.equal(caps.verifyResultSecret('wake_a', 'wrong'), false);
  assert.equal(caps.verifyResultSecret('wake_a', minted.resultSecret), true);
  assert.equal(caps.verifyResultSecret('wake_a', minted.resultSecret), false, 'single use');

  const later = caps.mintJob({ owner: 'CODEXR', messageId: 'm2', replyTo: 'CC6', jobId: 'wake_c' });
  clock += 5000;
  assert.equal(caps.verifyResultSecret('wake_c', later.resultSecret), false, 'expired');
});
