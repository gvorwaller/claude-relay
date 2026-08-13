const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { RuntimeStatus, readRuntimeStatus, assessRuntimeStatus } = require('../runtime-status');
const { runRetention } = require('../retention');

function healthyChecks() {
  return {
    listenerLoopback: true,
    ancestryBindingReady: true,
    messageStore: true,
    capabilityStore: true,
    jobStore: true,
    notifyConfig: true
  };
}

test('runtime status is atomic, bounded, and assessable without relay content', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-health-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'runtime-status.json');
  const now = new Date('2026-08-12T12:00:00Z');
  const status = new RuntimeStatus({ filePath: file, now: () => now });
  status.initialize({
    host: '127.0.0.1', port: 9999, checks: healthyChecks(),
    metrics: { jobsTotal: 2, jobsUnreported: 1, ownersPending: 0 }, alerts: []
  });
  const parsed = readRuntimeStatus(file);
  const assessment = assessRuntimeStatus(parsed, {
    now: now.getTime(), pidAlive: () => true
  });
  assert.equal(assessment.ok, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /prompt text|TOP SECRET|command output/i);
});

test('health command fails closed for exposed listener, ancestry failure, and capacity alert', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-health-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'runtime-status.json'), JSON.stringify({
    version: 1, pid: process.pid, startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), host: '0.0.0.0', port: 9999,
    checks: { ...healthyChecks(), listenerLoopback: false, ancestryBindingReady: false },
    metrics: {}, alerts: [{ code: 'job_store_at_capacity', severity: 'error' }]
  }));
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'relay-health.js'), '--data-dir', root
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /listener is exposed|ancestry binding is unavailable|at capacity/);
});

test('health command names actionable owner credentials instead of pending enrollments', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-health-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'runtime-status.json'), JSON.stringify({
    version: 1, pid: process.pid, startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), host: '127.0.0.1', port: 9999,
    checks: healthyChecks(), alerts: [],
    metrics: { ownersPending: 2, ownersPendingLabels: ['CC2', 'CODEX1'] }
  }));
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'relay-health.js'), '--data-dir', root
  ], { encoding: 'utf8' });
  assert.match(result.stdout, /named-owner-credentials-pending=2/);
  assert.match(result.stdout, /CC2, CODEX1/);
  assert.doesNotMatch(result.stdout, /pending-enrollments/);
});

test('scheduled retention invokes every store and refreshes runtime status', () => {
  const calls = [];
  const result = runRetention({
    messageStore: { prune() { calls.push('messages'); } },
    logger: { prune() { calls.push('logs'); } },
    capabilities: { pruneUnacknowledged() { calls.push('owners'); return 2; } },
    jobStore: { prune() { calls.push('jobs'); return { removed: 3 }; } },
    refreshRuntimeStatus() { calls.push('health'); }
  });
  assert.deepEqual(calls, ['messages', 'logs', 'owners', 'jobs', 'health']);
  assert.deepEqual(result, { ownersRemoved: 2, jobs: { removed: 3 } });
});

test('relay-monitor renders only a fixed capacity alert', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-health-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'jobs'));
  fs.writeFileSync(path.join(root, 'runtime-status.json'), JSON.stringify({
    alerts: [{ code: 'job_store_at_capacity', detail: 'TOP SECRET' }]
  }));
  const output = execFileSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'relay-monitor.js'), '--data-dir', root, '--once'
  ], { encoding: 'utf8' });
  assert.match(output, /ALERT  Delegate job store is at capacity/);
  assert.doesNotMatch(output, /TOP SECRET/);
});
