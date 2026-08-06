const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CapabilityStore } = require('/Users/gaylonvorwaller/claude-relay/capabilities');

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
  assert.equal(caps.consumeJob(job.token, 'CODEX9'), null, 'derived job revoked by rotation');
  assert.equal(caps.ownerGeneration('CODEX9'), 2);
});

test('job capability is single-use, owner-bound, and expiring', t => {
  let clock = 1_000_000;
  const { store: caps } = store(t, { now: () => clock, jobTtlMs: 1000 });
  caps.mintOwner('CODEX9');

  const job = caps.mintJob({ owner: 'CODEX9', messageId: 'm7' });
  assert.equal(caps.consumeJob(job.token, 'OTHER'), null, 'owner-bound');

  const fresh = caps.mintJob({ owner: 'CODEX9', messageId: 'm8' });
  const consumed = caps.consumeJob(fresh.token, 'CODEX9');
  assert.equal(consumed.messageId, 'm8');
  assert.equal(caps.consumeJob(fresh.token, 'CODEX9'), null, 'single use');

  const expiring = caps.mintJob({ owner: 'CODEX9', messageId: 'm9' });
  clock += 5000;
  assert.equal(caps.consumeJob(expiring.token, 'CODEX9'), null, 'expired');

  assert.equal(caps.consumeJob('not-a-token', 'CODEX9'), null);
  assert.equal(caps.consumeJob(undefined, 'CODEX9'), null);
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
  const consumed = caps.consumeJob(token, 'CODEXJ');
  assert.equal(consumed.spawnPid, 4242);
  assert.equal(consumed.replyTo, 'CC6');

  // Revocation before consumption.
  const second = caps.mintJob({ owner: 'CODEXJ', messageId: 'm2', replyTo: 'CC6' });
  caps.revokeJobByKey(second.key);
  assert.equal(caps.consumeJob(second.token, 'CODEXJ'), null);
});
