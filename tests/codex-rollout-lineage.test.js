const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  detectCodexRolloutContext,
  rolloutIdFromPath,
  rolloutSessionIds
} = require('../codex-rollout-lineage');

function rolloutFile(root, date, id) {
  return path.join(root, `rollout-${date}-${id}.jsonl`);
}

test('rolloutIdFromPath extracts the Codex rollout UUID', () => {
  assert.equal(
    rolloutIdFromPath('/tmp/rollout-2026-08-21T18-09-30-01a0265f-3d65-75a0-a32c-e99c12ed5905.jsonl'),
    '01a0265f-3d65-75a0-a32c-e99c12ed5905'
  );
});

test('rolloutSessionIds reads current and inherited session metadata', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codex-lineage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const current = '22222222-2222-4222-8222-222222222222';
  const predecessor = '11111111-1111-4111-8111-111111111111';
  const file = rolloutFile(root, '2026-08-21T18-09-30', current);
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session_meta', payload: { id: current } }),
    JSON.stringify({ type: 'session_meta', payload: { id: predecessor } }),
    JSON.stringify({ type: 'event_msg', payload: { message: predecessor } })
  ].join('\n'));

  assert.deepEqual([...rolloutSessionIds(file)].sort(), [current, predecessor].sort());
});

test('detectCodexRolloutContext selects the active continuation and retains its lineage', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codex-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const predecessor = '11111111-1111-4111-8111-111111111111';
  const current = '22222222-2222-4222-8222-222222222222';
  const oldFile = rolloutFile(root, '2026-08-19T20-30-55', predecessor);
  const currentFile = rolloutFile(root, '2026-08-21T18-09-30', current);
  fs.writeFileSync(oldFile,
    `${JSON.stringify({ type: 'session_meta', payload: { id: predecessor } })}\n`);
  fs.writeFileSync(currentFile, [
    JSON.stringify({ type: 'session_meta', payload: { id: current } }),
    JSON.stringify({ type: 'session_meta', payload: { id: predecessor } })
  ].join('\n'));
  const now = Date.now() / 1000;
  fs.utimesSync(oldFile, now - 60, now - 60);
  fs.utimesSync(currentFile, now, now);

  const context = detectCodexRolloutContext(123, { files: [oldFile, currentFile] });
  assert.equal(context.currentId, current);
  assert.equal(context.rolloutFile, currentFile);
  assert.deepEqual([...context.lineageIds].sort(), [current, predecessor].sort());
});
