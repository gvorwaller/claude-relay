'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  delegateJobDetail, delegateJobReportLines, operatorOwnerRepair,
  previewJobCleanup, purgeJobCleanup, restartRelay, scrollWindow, topologyLines
} = require('../monitor-control');

function writeJob(root, id, owner, status) {
  const jobs = path.join(root, 'jobs');
  fs.mkdirSync(jobs, { recursive: true });
  fs.writeFileSync(path.join(jobs, `${id}.json`), JSON.stringify({
    jobId: id, owner, status, requestedAt: new Date().toISOString(), outbound: []
  }));
}

test('monitor cleanup previews exact owner and cannot remove active work', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-monitor-control-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const completed = 'wake_10000000-0000-4000-8000-000000000001';
  const running = 'wake_10000000-0000-4000-8000-000000000002';
  const other = 'wake_10000000-0000-4000-8000-000000000003';
  writeJob(root, completed, 'CODEX1', 'completed');
  writeJob(root, running, 'CODEX1', 'running');
  writeJob(root, other, 'CODEX3', 'reported');

  const preview = previewJobCleanup(root, 'CODEX1');
  assert.equal(preview.count, 1);
  assert.equal(purgeJobCleanup(root, 'CODEX1', 'wrong').confirmed, false);
  const result = purgeJobCleanup(root, 'CODEX1', preview.confirmation);
  assert.equal(result.purged, 1);
  assert.equal(fs.existsSync(path.join(root, 'jobs', `${running}.json`)), true);
  assert.equal(fs.existsSync(path.join(root, 'jobs', `${other}.json`)), true);
});

test('monitor restart targets only the exact per-user launchd relay label', () => {
  const calls = [];
  const result = restartRelay({
    uid: 501,
    spawnSync(command, args) {
      calls.push({ command, args });
      return { status: 0, stdout: '', stderr: '' };
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{
    command: 'launchctl', args: ['kickstart', '-k', 'gui/501/com.claude-relay']
  }]);
});

test('monitor repairs a missing launchd registration from the exact installed plist', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-monitor-plist-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plist = path.join(root, 'com.claude-relay.plist');
  fs.writeFileSync(plist, 'test');
  const calls = [];
  const result = restartRelay({
    uid: 501, plistPath: plist,
    spawnSync(command, args) {
      calls.push(args);
      if (calls.length === 1) return { status: 3, stderr: 'not loaded' };
      return { status: 0, stderr: '' };
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ['kickstart', '-k', 'gui/501/com.claude-relay'],
    ['bootstrap', 'gui/501', plist],
    ['kickstart', '-k', 'gui/501/com.claude-relay']
  ]);
});

test('topology view distinguishes peer identities from detailed live sessions', () => {
  const lines = topologyLines({
    peers: ['CC1', 'CODEX1', 'CC1-watch-12345-deadbeef'],
    pendingOwnerLabels: ['CODEX1'],
    sessions: {
      CODEX1: { host: 'Mac', source: 'codex', cwd: '/repo', pid: 42 },
      CC1: { host: 'Mac', source: 'claude-code' }
    }
  }).join('\n');
  assert.match(lines, /Connected agent peers: 2/);
  assert.match(lines, /CC1, CODEX1/);
  assert.match(lines, /Background message watchers: 1/);
  assert.match(lines, /CC1 — Mac • claude-code/);
  assert.match(lines, /CODEX1 — Mac • codex • \/repo • pid 42 • owner credential not confirmed/);
});

test('credential repair requires one exact named identity', async () => {
  await assert.rejects(operatorOwnerRepair('/unused', 'all'), /one exact named identity/);
  await assert.rejects(operatorOwnerRepair('/unused', '../CC1'), /one exact named identity/);
});

test('delegate detail joins durable messages and separates relay evidence from delegate prose', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-monitor-detail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jobId = 'wake_10000000-0000-4000-8000-000000000004';
  fs.mkdirSync(path.join(root, 'jobs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'messages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'jobs', `${jobId}.json`), JSON.stringify({
    jobId, owner: 'CODEX', from: 'M2', status: 'completed', inboundMessageId: 'in-1',
    requestedAt: '2026-08-13T18:45:40.000Z', startedAt: '2026-08-13T18:45:41.000Z',
    completedAt: '2026-08-13T18:46:10.000Z', summary: 'Replied to the test.',
    changes: 'None', verification: ['ACK delivered'], exitCode: 0,
    activity: [{ type: 'reading_message', at: '2026-08-13T18:45:42.000Z' }],
    outbound: [{ to: 'M2', messageId: 'out-1', delivered: true, at: '2026-08-13T18:46:10.000Z' }]
  }));
  fs.writeFileSync(path.join(root, 'messages', '2026-08-13.jsonl'), [
    JSON.stringify({ id: 'in-1', from: 'M2', to: 'CODEX', content: 'Please ACK', timestamp: '2026-08-13T18:45:40.000Z' }),
    JSON.stringify({ id: 'out-1', from: 'CODEX', to: 'M2', content: 'ACK', timestamp: '2026-08-13T18:46:10.000Z' }),
    ''
  ].join('\n'));

  const lines = delegateJobReportLines(delegateJobDetail(root, jobId)).join('\n');
  assert.match(lines, /INCOMING REQUEST\nPlease ACK/);
  assert.match(lines, /RELAY-OBSERVED RESULT\nReply to M2: ACK\nDelivery: Delivered live/);
  assert.match(lines, /DELEGATE REPORT\nReplied to the test\./);
  assert.match(lines, /CHANGES\nNone/);
  assert.match(lines, /VERIFICATION\n• ACK delivered/);
  assert.match(lines, /SANITIZED ACTIVITY TIMELINE[\s\S]*Reading relay message/);
});

test('delegate detail never infers a reply which lacks server attribution', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-monitor-unattributed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jobId = 'wake_10000000-0000-4000-8000-000000000005';
  writeJob(root, jobId, 'CODEX', 'completed');
  const file = path.join(root, 'jobs', `${jobId}.json`);
  const job = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(job, { from: 'M2', inboundMessageId: null, summary: 'I sent ACK.', activity: [] });
  fs.writeFileSync(file, JSON.stringify(job));
  const lines = delegateJobReportLines(delegateJobDetail(root, jobId)).join('\n');
  assert.match(lines, /No outbound reply was attributed to this delegate job/);
  assert.match(lines, /DELEGATE REPORT\nI sent ACK\./);
});

test('delegate detail scrolling uses a bounded internal viewport', () => {
  const lines = Array.from({ length: 24 }, (_, index) => `line-${index + 1}`);
  assert.deepEqual(scrollWindow(lines, 0, 8), {
    lines: lines.slice(0, 8), offset: 0, maximum: 16, first: 1, last: 8, total: 24
  });
  assert.deepEqual(scrollWindow(lines, 1, 8), {
    lines: lines.slice(1, 9), offset: 1, maximum: 16, first: 2, last: 9, total: 24
  });
  const end = scrollWindow(lines, 999, 8);
  assert.equal(end.offset, 16);
  assert.deepEqual(end.lines, lines.slice(16));
  assert.deepEqual(scrollWindow(['only'], 1, 8), {
    lines: ['only'], offset: 0, maximum: 0, first: 1, last: 1, total: 1
  });
});
