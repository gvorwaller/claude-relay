'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  operatorOwnerRepair, previewJobCleanup, purgeJobCleanup, restartRelay, topologyLines
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
