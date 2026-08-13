const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DelegateJobStore } = require('../delegate-job-store');

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

test('terminal and reported receipts are immutable', t => {
  const { store } = makeStore(t);
  const job = store.create({ owner: 'CODEX3', inboundMessageId: 'i1', from: 'CC6' });
  store.transition(job.jobId, 'running');
  store.transition(job.jobId, 'completed');

  // A late send cannot mutate a finished receipt.
  assert.equal(store.recordOutbound(job.jobId, { to: 'CC6', messageId: 'late', delivered: true }), null);
  assert.deepEqual(store.get(job.jobId).outbound, []);

  // A late registration cannot restart it.
  assert.equal(store.transition(job.jobId, 'running'), null);

  // A replayed acknowledgement cannot rewrite who reported it.
  store.transition(job.jobId, 'reported', { reportedTurnId: 'turn-1' });
  store.transition(job.jobId, 'reported', { reportedTurnId: 'turn-2' });
  assert.equal(store.get(job.jobId).reportedTurnId, 'turn-1');
});

test('a wake that exits without a delegate is distinct from a completed one', t => {
  const { store } = makeStore(t);
  const bare = store.create({ owner: 'CODEX3', inboundMessageId: 'i2', from: 'CC6' });
  assert.ok(store.transition(bare.jobId, 'exited_no_delegate', { exitCode: 0 }));
  assert.equal(store.get(bare.jobId).status, 'exited_no_delegate');
  // It is still reportable — the human is owed the fact that nothing happened.
  assert.ok(store.pending('CODEX3').some(j => j.jobId === bare.jobId));
  // But it can never be dressed up as a completed run.
  assert.equal(store.transition(bare.jobId, 'completed'), null);
});

test('backpressure rejects new work rather than pruning running or unreported jobs', t => {
  let clock = Date.parse('2026-08-06T00:00:00.000Z');
  const capacityEvents = [];
  const { store } = makeStore(t, {
    now: () => clock,
    maxJobs: 1,
    retentionDays: 7,
    onCapacity: stats => capacityEvents.push(stats)
  });
  const running = store.create({ owner: 'CODEX3', inboundMessageId: 'r1', from: 'CC6' });
  assert.equal(capacityEvents.length, 1, 'reaching capacity is reported immediately');
  assert.equal(capacityEvents[0].atCapacity, true);
  store.transition(running.jobId, 'running');
  assert.throws(
    () => store.create({ owner: 'CODEX3', inboundMessageId: 'r2', from: 'CC6' }),
    /at capacity/
  );
  assert.ok(capacityEvents.length >= 2, 'rejected work refreshes the capacity signal');

  clock += 60 * 24 * 60 * 60 * 1000;
  store.prune();
  assert.ok(store.get(running.jobId), 'an in-flight job is never pruned under count pressure');
});

test('terminal job purge is owner-scoped, preview-confirmed, and preserves active work', t => {
  const { store } = makeStore(t);
  const one = store.create({ owner: 'CODEX1', inboundMessageId: 'p1', from: 'CC1' });
  store.transition(one.jobId, 'running');
  store.transition(one.jobId, 'completed');
  const other = store.create({ owner: 'CODEX2', inboundMessageId: 'p2', from: 'CC2' });
  store.transition(other.jobId, 'failed');
  const active = store.create({ owner: 'CODEX1', inboundMessageId: 'p3', from: 'CC1' });
  store.transition(active.jobId, 'running');

  const preview = store.previewTerminalPurge('CODEX1');
  assert.equal(preview.count, 1);
  assert.deepEqual(preview.byStatus, { completed: 1 });
  assert.deepEqual(preview.byOwner, { CODEX1: 1 });
  assert.equal(store.purgeTerminal('CODEX1', 'wrong').confirmed, false);
  assert.ok(store.get(one.jobId));

  const result = store.purgeTerminal('CODEX1', preview.confirmation);
  assert.equal(result.confirmed, true);
  assert.equal(result.purged, 1);
  assert.equal(store.get(one.jobId), null);
  assert.ok(store.get(active.jobId), 'running work is never selected or removed');
  assert.ok(store.get(other.jobId), 'another owner is outside the selection');

  const all = store.previewTerminalPurge('all');
  assert.equal(all.count, 1);
  assert.equal(store.purgeTerminal('all', all.confirmation).purged, 1);
  assert.ok(store.get(active.jobId));
});

test('activity accepts only allowlisted categories and suppresses duplicates', t => {
  const { store } = makeStore(t);
  const job = store.create({ owner: 'CODEX3', inboundMessageId: 'a1', from: 'CC6' });
  store.recordActivity(job.jobId, { type: 'running_command', command: 'cat /secret' });
  store.recordActivity(job.jobId, { type: 'running_command' });
  assert.equal(store.recordActivity(job.jobId, { type: 'raw_tool_output' }), null);
  assert.deepEqual(store.get(job.jobId).activity.map(a => Object.keys(a).sort()), [['at', 'type']]);
  assert.equal(store.get(job.jobId).activity[0].type, 'running_command');
});

test('invalid or misnamed records are quarantined, not silently dropped', t => {
  const { store, dir } = makeStore(t);
  const job = store.create({ owner: 'CODEX3', inboundMessageId: 'q1', from: 'CC6' });
  // Corrupt the record's identity so it no longer matches its filename.
  const file = path.join(dir, `${job.jobId}.json`);
  fs.writeFileSync(file, JSON.stringify({ jobId: 'wake_../escape', owner: 'X', status: 'spawned', requestedAt: new Date().toISOString(), outbound: [] }));

  const reopened = new DelegateJobStore({ dataDir: dir }).initialize();
  assert.equal(reopened.get(job.jobId), null);
  assert.ok(fs.existsSync(`${file}.quarantined`), 'bad records are kept for recovery, not deleted');
});

test('jobs from a previous server instance are interrupted, not resurrected by pid reuse', t => {
  const { store, dir } = makeStore(t, { instanceId: 'run-1' });
  const job = store.create({ owner: 'CODEX3', inboundMessageId: 'p1', from: 'CC6' });
  // A pid that is definitely alive — this test process.
  store.transition(job.jobId, 'running', { spawnPid: process.pid });

  const nextRun = new DelegateJobStore({ dataDir: dir, instanceId: 'run-2' }).initialize();
  assert.equal(nextRun.get(job.jobId).status, 'interrupted',
    'a job whose capability died with the old server cannot be considered alive');
});

test('a wrapper result attaches narrative without moving the state machine', t => {
  const { store } = makeStore(t);
  const job = store.create({ owner: 'CODEX3', inboundMessageId: 'w1', from: 'CC6' });
  store.transition(job.jobId, 'running');
  store.recordOutbound(job.jobId, { to: 'CC6', messageId: 'msg-1', delivered: true });

  store.attachResult(job.jobId, {
    summary: 'Reviewed the store and sent findings.',
    changes: 'No files changed.',
    verification: ['unit tests 30/30']
  });

  const withResult = store.get(job.jobId);
  assert.equal(withResult.status, 'running', 'prose never advances the state machine');
  assert.equal(withResult.summary, 'Reviewed the store and sent findings.');
  assert.deepEqual(withResult.verification, ['unit tests 30/30']);
  // The delegate's account cannot rewrite the server's evidence.
  assert.deepEqual(withResult.outbound.map(o => o.messageId), ['msg-1']);

  // And it cannot change a receipt after the human was told.
  store.transition(job.jobId, 'completed');
  store.transition(job.jobId, 'reported', { reportedTurnId: 't1' });
  assert.equal(store.attachResult(job.jobId, { summary: 'revised story' }), null);
  assert.equal(store.get(job.jobId).summary, 'Reviewed the store and sent findings.');
});
