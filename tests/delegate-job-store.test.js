const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DelegateJobStore } = require('/Users/gaylonvorwaller/claude-relay/delegate-job-store');

function makeStore(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-jobs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { store: new DelegateJobStore({ dataDir: dir, ...options }).initialize(), dir };
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '']);
  const pid = child.pid;
  await new Promise(resolve => child.once('exit', resolve));
  return pid;
}

test('valid lifecycle runs spawned -> running -> completed -> reported', t => {
  const { store } = makeStore(t);
  const job = store.create({ owner: 'CODEX3', inboundMessageId: 'm1', from: 'CC6' });
  assert.equal(job.status, 'spawned');

  assert.ok(store.transition(job.jobId, 'running', { delegateId: 'CODEX3~wake-abc' }));
  assert.equal(store.get(job.jobId).delegateId, 'CODEX3~wake-abc');
  assert.ok(store.get(job.jobId).startedAt);

  assert.ok(store.transition(job.jobId, 'completed', { summary: 'did the thing' }));
  assert.ok(store.get(job.jobId).completedAt);

  assert.ok(store.transition(job.jobId, 'reported', { reportedTurnId: 'turn-9' }));
  assert.equal(store.get(job.jobId).reportedTurnId, 'turn-9');
});

test('invalid transitions fail closed and leave state untouched', t => {
  const { store } = makeStore(t);
  const job = store.create({ owner: 'CODEX3', inboundMessageId: 'm2', from: 'CC6' });

  // Cannot jump straight to reported: a job must reach a terminal run state
  // first, or a human could be told about work that never finished.
  assert.equal(store.transition(job.jobId, 'reported'), null);
  assert.equal(store.get(job.jobId).status, 'spawned');

  store.transition(job.jobId, 'running');
  assert.equal(store.transition(job.jobId, 'spawned'), null, 'no going backwards');
  assert.equal(store.get(job.jobId).status, 'running');

  assert.equal(store.transition('wake_nonexistent', 'running'), null);
});

test('transitions are idempotent', t => {
  const { store } = makeStore(t);
  const job = store.create({ owner: 'CC5', inboundMessageId: 'm3', from: 'CC6' });
  store.transition(job.jobId, 'running');
  const first = store.transition(job.jobId, 'completed', { summary: 'one' });
  const again = store.transition(job.jobId, 'completed', { summary: 'one' });
  assert.equal(first.completedAt, again.completedAt, 'repeat does not restamp');
  assert.equal(store.get(job.jobId).status, 'completed');
});

test('outbound sends are recorded as server evidence', t => {
  const { store } = makeStore(t);
  const job = store.create({ owner: 'CODEX3', inboundMessageId: 'm4', from: 'CC6' });
  store.transition(job.jobId, 'running');
  store.recordOutbound(job.jobId, { to: 'CC6', messageId: 'msg-1', delivered: true });
  store.recordOutbound(job.jobId, { to: 'CC6', messageId: 'msg-2', delivered: false });

  const outbound = store.get(job.jobId).outbound;
  assert.equal(outbound.length, 2);
  assert.deepEqual(outbound.map(o => o.messageId), ['msg-1', 'msg-2']);
  assert.equal(outbound[0].delivered, true);
  assert.equal(outbound[1].delivered, false, 'queued is recorded as queued, never as delivered');
});

test('pending() returns only this owner\'s terminal-but-unreported jobs', t => {
  const { store } = makeStore(t);
  const mine = store.create({ owner: 'CODEX3', inboundMessageId: 'a', from: 'CC6' });
  const theirs = store.create({ owner: 'CC5', inboundMessageId: 'b', from: 'CC6' });
  const running = store.create({ owner: 'CODEX3', inboundMessageId: 'c', from: 'CC6' });
  const done = store.create({ owner: 'CODEX3', inboundMessageId: 'd', from: 'CC6' });

  store.transition(mine.jobId, 'running');
  store.transition(mine.jobId, 'completed');
  store.transition(theirs.jobId, 'running');
  store.transition(theirs.jobId, 'completed');
  store.transition(running.jobId, 'running');
  store.transition(done.jobId, 'failed');

  const pending = store.pending('CODEX3').map(j => j.jobId);
  assert.ok(pending.includes(mine.jobId));
  assert.ok(pending.includes(done.jobId), 'failures surface exactly like successes');
  assert.ok(!pending.includes(running.jobId), 'still running is not reportable');
  assert.ok(!pending.includes(theirs.jobId), 'owner-scoped');

  store.markReported([mine.jobId, done.jobId], 'turn-1');
  assert.deepEqual(store.pending('CODEX3'), []);
});

test('a job whose process died is recovered as interrupted, not lost', async t => {
  const { store, dir } = makeStore(t);
  const job = store.create({ owner: 'CODEX3', inboundMessageId: 'm5', from: 'CC6' });
  store.transition(job.jobId, 'running', { spawnPid: await deadPid() });

  // Restart: the delegate process is gone and never reported anything.
  const reopened = new DelegateJobStore({ dataDir: dir }).initialize();
  const recovered = reopened.get(job.jobId);
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.recovered, true);
  assert.ok(reopened.pending('CODEX3').some(j => j.jobId === job.jobId),
    'an interrupted job still owes the human a report');
});

test('records survive restart and keep their outbound evidence', t => {
  const { store, dir } = makeStore(t);
  const job = store.create({ owner: 'CODEX3', inboundMessageId: 'm6', from: 'CC6' });
  store.transition(job.jobId, 'running', { spawnPid: process.pid });
  store.recordOutbound(job.jobId, { to: 'CC6', messageId: 'msg-9', delivered: true });
  store.transition(job.jobId, 'completed', { summary: 'reviewed' });

  const reopened = new DelegateJobStore({ dataDir: dir }).initialize();
  const restored = reopened.get(job.jobId);
  assert.equal(restored.status, 'completed');
  assert.equal(restored.summary, 'reviewed');
  assert.deepEqual(restored.outbound.map(o => o.messageId), ['msg-9']);
});

test('retention never prunes a job the human has not been told about', t => {
  let clock = Date.parse('2026-08-06T00:00:00.000Z');
  const { store } = makeStore(t, { now: () => clock, retentionDays: 7 });

  const unreported = store.create({ owner: 'CODEX3', inboundMessageId: 'old1', from: 'CC6' });
  store.transition(unreported.jobId, 'running');
  store.transition(unreported.jobId, 'completed');

  const reported = store.create({ owner: 'CODEX3', inboundMessageId: 'old2', from: 'CC6' });
  store.transition(reported.jobId, 'running');
  store.transition(reported.jobId, 'completed');
  store.transition(reported.jobId, 'reported');

  clock += 30 * 24 * 60 * 60 * 1000; // a month later
  store.prune();

  assert.ok(store.get(unreported.jobId), 'unreported work is never silently dropped');
  assert.equal(store.get(reported.jobId), null, 'reported work ages out normally');
});
