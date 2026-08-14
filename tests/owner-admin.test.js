const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CapabilityStore } = require('../capabilities');
const { OwnerAdmin, readOrCreateAdminSecret, verifySecret } = require('../owner-admin');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-owner-admin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const capabilities = new CapabilityStore({ dataDir: root });
  const ownerDir = path.join(root, 'owner-secrets');
  const admin = new OwnerAdmin({ capabilities, dataDir: root, ownerDir });
  return { root, capabilities, ownerDir, admin };
}

test('local admin capability is stable, private, and timing-safe verified', t => {
  const { root } = setup(t);
  const file = path.join(root, 'admin.secret');
  const first = readOrCreateAdminSecret(file);
  const second = readOrCreateAdminSecret(file);
  assert.equal(first, second);
  assert.equal(verifySecret(first, second), true);
  assert.equal(verifySecret(first, 'wrong'), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('owner rotation writes a replacement secret and revokes the old generation', t => {
  const { capabilities, admin } = setup(t);
  const old = capabilities.mintOwner('CODEX9');
  const job = capabilities.mintJob({ owner: 'CODEX9', jobId: 'wake-old' });
  const result = admin.rotate('CODEX9');
  const replacement = fs.readFileSync(result.secretPath, 'utf8');
  assert.equal(capabilities.verifyOwner('CODEX9', old.secret), false);
  assert.equal(capabilities.verifyOwner('CODEX9', replacement), true);
  assert.equal(capabilities.authorizeJob(job.token, 'CODEX9').ok, false);
  assert.equal(fs.statSync(result.secretPath).mode & 0o777, 0o600);
});

test('an interrupted rotation journal is recovered deterministically', t => {
  const { root, capabilities, ownerDir, admin } = setup(t);
  fs.writeFileSync(ownerDir, 'not a directory');
  assert.throws(() => admin.rotate('RECOVER1'));
  const journals = fs.readdirSync(path.join(root, 'owner-rotations'));
  assert.equal(journals.length, 1);
  fs.unlinkSync(ownerDir);
  const recovered = admin.recover();
  assert.equal(recovered.length, 1);
  const secret = fs.readFileSync(admin.secretPath('RECOVER1'), 'utf8');
  assert.equal(capabilities.verifyOwner('RECOVER1', secret), true);
  assert.equal(fs.readdirSync(path.join(root, 'owner-rotations')).length, 0);
});

test('owner rotation rejects hostile labels before touching disk', t => {
  const { admin } = setup(t);
  assert.throws(() => admin.rotate('../escape'), /Invalid owner label/);
  assert.throws(() => admin.rotate('all'), /Invalid owner label/);
});

test('owner removal deletes the capability and saved secret after exact preview', t => {
  const { capabilities, admin } = setup(t);
  const rotated = admin.rotate('UNUSED1');
  assert.equal(fs.existsSync(rotated.secretPath), true);
  const preview = capabilities.previewOwnerRemoval('UNUSED1');
  assert.equal(admin.remove('UNUSED1', 'wrong').removed, false);
  assert.equal(capabilities.hasOwner('UNUSED1'), true);
  const removed = admin.remove('UNUSED1', preview.confirmation);
  assert.equal(removed.removed, true);
  assert.equal(capabilities.hasOwner('UNUSED1'), false);
  assert.equal(fs.existsSync(rotated.secretPath), false);
  assert.equal(fs.readdirSync(path.join(admin.dataDir, 'owner-removals')).length, 0);
});
