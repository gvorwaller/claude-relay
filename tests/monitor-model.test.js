'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildMonitorSnapshot, createStopDelegateController, projectIdentities, projectJob, projectJobDetail,
  projectJobs, readMonitorModel
} = require('../monitor-model');

const NOW = Date.parse('2026-08-29T16:00:00.000Z');

test('shared monitor model orders work and exposes only sanitized job fields', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-monitor-model-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'jobs'));
  const jobs = [
    {
      jobId: 'wake_10000000-0000-4000-8000-000000000001', owner: 'CC1', from: 'CODEX',
      status: 'running', requestedAt: '2026-08-29T15:30:00.000Z', startedAt: '2026-08-29T15:31:00.000Z',
      spawnPid: 4242, prompt: 'TOP SECRET', command: 'cat /private/key', reasoning: 'hidden',
      activity: [{ type: 'running_command', at: '2026-08-29T15:39:00.000Z', toolInput: 'secret' }],
      outbound: [{ to: 'CODEX', delivered: false, messageId: 'raw-message-id' }]
    },
    {
      jobId: 'wake_10000000-0000-4000-8000-000000000002', owner: 'CC2', from: 'CODEX',
      status: 'completed', requestedAt: '2026-08-29T15:50:00.000Z', outbound: []
    }
  ];
  for (const job of jobs) fs.writeFileSync(path.join(root, 'jobs', `${job.jobId}.json`), JSON.stringify(job));

  const model = readMonitorModel(root, { now: NOW, kill(pid, signal) {
    assert.equal(pid, -4242);
    assert.equal(signal, 0);
  } });
  assert.deepEqual(model.jobs.map(job => job.owner), ['CC2', 'CC1']);
  const active = model.jobs[1];
  assert.equal(active.latestActivity.label, 'Running a command');
  assert.equal(active.lastActivityAgeMs, 21 * 60 * 1000);
  assert.equal(active.stalled, 'possibly_stuck');
  assert.equal(active.processAlive, true);
  assert.deepEqual(active.outbound, [{ to: 'CODEX', delivered: false, at: null }]);

  const serialized = JSON.stringify(model);
  assert.doesNotMatch(serialized, /4242|TOP SECRET|cat \/private|hidden|toolInput|raw-message-id|"spawnPid"|"prompt"|"command"|"reasoning"/);
});

test('stalled-work hints use sanitized activity age and never imply termination', () => {
  const base = {
    jobId: 'wake_10000000-0000-4000-8000-000000000003', owner: 'CC1', from: 'CODEX',
    status: 'running', requestedAt: '2026-08-29T15:00:00.000Z', spawnPid: null, outbound: []
  };
  assert.equal(projectJob({ ...base, activity: [{ type: 'waiting', at: '2026-08-29T15:51:00.000Z' }] }, { now: NOW }).stalled, null);
  assert.equal(projectJob({ ...base, activity: [{ type: 'waiting', at: '2026-08-29T15:50:00.000Z' }] }, { now: NOW }).stalled, 'inactive');
  assert.equal(projectJob({ ...base, activity: [{ type: 'waiting', at: '2026-08-29T15:40:00.000Z' }] }, { now: NOW }).stalled, 'possibly_stuck');
  assert.equal(projectJob({ ...base, status: 'completed' }, { now: NOW }).stalled, null);
});

test('shared job projection preserves terminal ordering, filtering, and labels', () => {
  const records = [
    { owner: 'CC1', from: 'M2', status: 'running', requestedAt: '2026-08-29T15:00:00.000Z', activity: [{ type: 'reading_files', at: '2026-08-29T15:59:00.000Z' }] },
    { owner: 'CC2', from: 'M2', status: 'running', requestedAt: '2026-08-29T15:30:00.000Z', activity: [{ type: 'unknown', at: '2026-08-29T15:59:00.000Z' }] },
    { owner: 'CC1', from: 'M1', status: 'completed', requestedAt: '2026-08-29T15:45:00.000Z', activity: [] }
  ];
  const projected = projectJobs(records, { owner: 'CC1', limit: 2, now: NOW });
  assert.deepEqual(projected.map(job => [job.status, job.requester, job.latestActivity?.label || null]), [
    ['completed', 'M1', null],
    ['running', 'M2', 'Reading files']
  ]);
});

test('identity projection reduces cwd to basename and omits session process details', () => {
  const identities = projectIdentities({
    peers: ['CODEX'], pendingOwnerLabels: ['CC1'],
    sessions: { CODEX: { host: 'Mac', cwd: '/Users/person/secret/repo', source: 'codex', pid: 999 } },
    registeredSessions: { CC1: { cwd: '/Users/person/other' } }
  });
  assert.deepEqual(identities, [
    { identity: 'CC1', live: false, host: null, cwdBasename: 'other', source: null, credentialWarning: true },
    { identity: 'CODEX', live: true, host: 'Mac', cwdBasename: 'repo', source: 'codex', credentialWarning: false }
  ]);
  assert.doesNotMatch(JSON.stringify(identities), /Users|999/);
});

test('remote detail redacts credentials and local paths while retaining bounded report fields', () => {
  const detail = projectJobDetail({
    jobId: 'wake_10000000-0000-4000-8000-000000000004', owner: 'CC1', from: 'CODEX',
    status: 'failed', requestedAt: '2026-08-29T15:00:00.000Z',
    summary: 'Updated /Users/person/private/file with token=abcdef123',
    changes: 'Used sk-thiscredentialmustnotleavehost',
    verification: ['Checked /opt/private/app'], reason: 'secret=hunter2',
    activity: [{ type: 'using_tool', at: '2026-08-29T15:20:00.000Z', input: 'private' }],
    outbound: []
  }, { now: NOW });
  const serialized = JSON.stringify(detail);
  assert.match(detail.summary, /\[local path\]/);
  assert.match(detail.summary, /token=\[redacted\]/);
  assert.match(detail.changes, /\[redacted credential\]/);
  assert.match(detail.error.reason, /secret=\[redacted\]/);
  assert.doesNotMatch(serialized, /Users|\/opt|hunter2|thiscredentialmustnotleavehost|"input"/);
});

test('complete snapshot partitions active work and projects topology without raw records', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-monitor-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'jobs'));
  const active = {
    jobId: 'wake_10000000-0000-4000-8000-000000000005', owner: 'CC1', from: 'CODEX',
    status: 'running', requestedAt: '2026-08-29T15:00:00.000Z', outbound: []
  };
  const recent = {
    jobId: 'wake_10000000-0000-4000-8000-000000000006', owner: 'CC2', from: 'CODEX',
    status: 'completed', requestedAt: '2026-08-29T15:30:00.000Z', outbound: []
  };
  for (const job of [active, recent]) fs.writeFileSync(path.join(root, 'jobs', `${job.jobId}.json`), JSON.stringify(job));
  const result = await buildMonitorSnapshot(root, {
    now: NOW,
    topology: {
      peers: ['CC1', 'CC1-watch-100-deadbeef'], sessions: { CC1: { cwd: '/Users/person/repo', pid: 99 } },
      registeredSessions: {}, pendingOwnerLabels: []
    }
  });
  assert.deepEqual(result.activeWork.map(job => job.owner), ['CC1']);
  assert.deepEqual(result.recentWork.map(job => job.owner), ['CC2']);
  assert.deepEqual(result.identities.map(item => item.identity), ['CC1']);
  assert.doesNotMatch(JSON.stringify(result), /Users|99|watch-100|_recordName/);
});

test('stop preview is exact, state-bound, expiring, and single-use', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-monitor-stop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'jobs'));
  const jobId = 'wake_10000000-0000-4000-8000-000000000007';
  const file = path.join(root, 'jobs', `${jobId}.json`);
  const job = {
    jobId, owner: 'CC1', from: 'CODEX', status: 'running', spawnPid: 4321,
    serverInstance: 'test-instance', requestedAt: '2026-08-29T15:00:00.000Z', outbound: []
  };
  fs.writeFileSync(file, JSON.stringify(job));
  let now = NOW;
  let alive = true;
  const terminated = [];
  const tokens = ['A', 'B', 'C', 'D', 'E'].map(value => value.repeat(43));
  const controller = createStopDelegateController(root, {
    now: () => now, kill(pid, signal) {
      assert.deepEqual([pid, signal], [-4321, 0]);
      if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    },
    tokenFactory: () => tokens.shift(),
    operatorTerminateDelegate: async (dataRoot, exactJobId) => {
      terminated.push([dataRoot, exactJobId]);
      return { signaled: true };
    }
  });

  const first = controller.preview(jobId);
  assert.deepEqual({ jobId: first.jobId, owner: first.owner, processAlive: first.processAlive }, {
    jobId, owner: 'CC1', processAlive: true
  });
  assert.doesNotMatch(JSON.stringify(first), /4321|spawnPid|test-instance/);
  const result = await controller.confirm(jobId, first.confirmationToken);
  assert.equal(result.status, 'interrupted');
  assert.deepEqual(terminated, [[root, jobId]]);
  await assert.rejects(controller.confirm(jobId, first.confirmationToken), /invalid or already used/);

  const changed = controller.preview(jobId);
  fs.writeFileSync(file, JSON.stringify({ ...job, status: 'spawned' }));
  await assert.rejects(controller.confirm(jobId, changed.confirmationToken), /state changed/);
  fs.writeFileSync(file, JSON.stringify(job));

  const livenessChanged = controller.preview(jobId);
  alive = false;
  await assert.rejects(controller.confirm(jobId, livenessChanged.confirmationToken), /state changed/);
  alive = true;

  const wrongTarget = controller.preview(jobId);
  await assert.rejects(controller.confirm(
    'wake_10000000-0000-4000-8000-000000000099', wrongTarget.confirmationToken
  ), /invalid or already used/);

  const expired = controller.preview(jobId);
  now += 60_001;
  await assert.rejects(controller.confirm(jobId, expired.confirmationToken), /expired/);
  assert.equal(terminated.length, 1);
});
