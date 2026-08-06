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
