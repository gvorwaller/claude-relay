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


test('identity removal clears only its registry entry and preserves history', t => {
  const { root, capabilities, admin } = setup(t);
  admin.registryPath = path.join(root, 'registry.json');
  const registry = { REMOVE1: { pid: process.pid }, KEEP1: { pid: process.pid } };
  fs.writeFileSync(admin.registryPath, JSON.stringify(registry));
  const history = path.join(root, 'history.json');
  fs.writeFileSync(history, 'preserved history');
  admin.rotate('REMOVE1');
  const preview = capabilities.previewOwnerRemoval('REMOVE1');
  admin.remove('REMOVE1', 'wrong');
  assert.deepEqual(JSON.parse(fs.readFileSync(admin.registryPath)), registry);
  admin.remove('REMOVE1', preview.confirmation);
  assert.deepEqual(JSON.parse(fs.readFileSync(admin.registryPath)), { KEEP1: registry.KEEP1 });
  assert.equal(fs.readFileSync(history, 'utf8'), 'preserved history');
  const backups = fs.readdirSync(path.join(root, 'backups'));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'backups', backups[0]))), registry);
});

test('interrupted registry cleanup leaves a journal and completes on recovery', t => {
  const { root, capabilities, admin } = setup(t);
  admin.registryPath = path.join(root, 'registry.json');
  admin.rotate('RETRY1');
  fs.writeFileSync(admin.registryPath, 'malformed');
  const preview = capabilities.previewOwnerRemoval('RETRY1');
  assert.throws(() => admin.remove('RETRY1', preview.confirmation));
  assert.equal(capabilities.hasOwner('RETRY1'), false);
  assert.equal(fs.existsSync(admin.removalJournalPath('RETRY1')), true);
  fs.writeFileSync(admin.registryPath, JSON.stringify({ RETRY1: { pid: process.pid }, KEEP1: {} }));
  admin.recover();
  assert.deepEqual(JSON.parse(fs.readFileSync(admin.registryPath)), { KEEP1: {} });
  assert.equal(fs.existsSync(admin.removalJournalPath('RETRY1')), false);
});
