'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  actionGates, createAdminController, createLocalAuditWriter,
  enabledActions, validateAdminTarget
} = require('../monitor-admin');

function allGates(overrides = {}) {
  return {
    restart_relay: true, cleanup_activity: true, repair_owner_credential: true,
    remove_identity: true, cleanup_messages: true,
    cleanup_activity_all: false, cleanup_messages_all: false, ...overrides
  };
}

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-monitor-admin-'));
  fs.mkdirSync(path.join(root, 'jobs'));
  fs.mkdirSync(path.join(root, 'messages'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const records = [{
    jobId: 'wake_10000000-0000-4000-8000-000000000001', _recordName: 'wake_10000000-0000-4000-8000-000000000001',
    owner: 'CODEX1', status: 'completed', requestedAt: '2026-08-29T10:00:00.000Z', completedAt: '2026-08-29T10:05:00.000Z'
  }];
  const messages = [
    { id: 'private-id-1', from: 'CODEX1', to: 'CC1', timestamp: '2026-08-29T11:00:00.000Z', content: 'private body' },
    { id: 'private-id-2', from: 'CC2', to: 'CODEX1', timestamp: '2026-08-30T11:00:00.000Z', content: 'other private body' }
  ];
  const operations = {
    readJobRecords: () => records.map(item => ({ ...item })),
    readMessageRecords: () => messages.map(item => ({ ...item })),
    healthAssessment: () => ({ status: {}, assessment: { ok: true } }),
    restartRelay: () => { calls.push(['restart']); return { ok: true }; },
    operatorJobRequest: async (_root, action, details) => {
      calls.push(['jobs', action, { ...details }]);
      return action === 'preview'
        ? { owner: details.owner, count: 1, byStatus: { completed: 1 }, byOwner: { CODEX1: 1 }, confirmation: 'inner-job-confirmation' }
        : { purged: 1, confirmed: true };
    },
    pendingOwnerLabels: () => ['CODEX1'],
    relayTopology: async () => ({ peers: ['CODEX1'] }),
    operatorOwnerRepair: async (_root, identity) => { calls.push(['repair', identity]); return {}; },
    operatorRemovableOwners: async () => [{ identity: 'CODEX2', live: false }],
    operatorOwnerRemoval: async (_root, action, identity) => {
      calls.push(['owner', action, identity]);
      return action === 'preview'
        ? { identity, acknowledged: true, live: false, lastActivity: '2026-08-20T00:00:00.000Z', confirmation: 'inner-owner-confirmation' }
        : { identity, liveConnectionStopped: false };
    },
    operatorMessageRequest: async (_root, action, details) => {
      calls.push(['messages', action, { ...details }]);
      return action === 'preview'
        ? { owner: details.owner, count: 2, byIdentity: { CODEX1: 2, CC1: 1, CC2: 1 }, confirmation: 'inner-message-confirmation' }
        : { purged: 2, confirmed: true };
    },
    ...(overrides.operations || {})
  };
  let token = 0;
  const auditRecords = [];
  const controller = createAdminController(root, {
    installationId: 'test-installation', gates: overrides.gates || allGates(), operations,
    jobStoreReadable: () => true, plistPresent: () => true, serviceState: async () => 'running',
    tokenFactory: () => String.fromCharCode(65 + token++).repeat(43),
    audit: overrides.audit || { preflight() {}, write(record) { auditRecords.push(record); } },
    ...(overrides.controllerOptions || {})
  });
  return { root, calls, records, messages, controller, auditRecords };
}

test('environment gates default deny and advertise a sorted strict action set', () => {
  assert.deepEqual(enabledActions(actionGates({})), []);
  const gates = actionGates({
    MONITOR_ADMIN_MESSAGE_CLEANUP_ENABLED: '1', MONITOR_ADMIN_RESTART_ENABLED: '1',
    MONITOR_ADMIN_ACTIVITY_CLEANUP_ALL_ENABLED: '1'
  });
  assert.deepEqual(enabledActions(gates), ['cleanup_messages', 'restart_relay']);
  assert.equal(gates.cleanup_activity_all, true);
});

test('admin target schemas reject unknown fields, hostile identities, and separately gated all scopes', () => {
  const gates = allGates();
  assert.deepEqual(validateAdminTarget('restart_relay', {}, gates), {});
  assert.throws(() => validateAdminTarget('restart_relay', { service: 'other' }, gates), /invalid_target/);
  assert.throws(() => validateAdminTarget('remove_identity', { identity: '../CC1' }, gates), /invalid_target/);
  assert.throws(() => validateAdminTarget('cleanup_activity', { scope: 'all' }, gates), /scope_disabled/);
  assert.throws(() => validateAdminTarget('cleanup_messages', { scope: 'all' }, gates), /scope_disabled/);
  assert.deepEqual(validateAdminTarget('cleanup_activity', { scope: 'owner', identity: 'CODEX1' }, gates), { scope: 'owner', identity: 'CODEX1' });
});

test('all five exact actions return metadata-only previews and invoke existing local operations', async t => {
  const { controller, calls, auditRecords } = fixture(t);
  const cases = [
    ['restart_relay', {}],
    ['cleanup_activity', { scope: 'owner', identity: 'CODEX1' }],
    ['repair_owner_credential', { identity: 'CODEX1' }],
    ['remove_identity', { identity: 'CODEX2' }],
    ['cleanup_messages', { scope: 'identity', identity: 'CODEX1' }]
  ];
  for (const [action, target] of cases) {
    const preview = await controller.preview(action, target);
    assert.equal(preview.action, action);
    assert.match(preview.confirmationToken, /^[A-Z]{43}$/);
    const serialized = JSON.stringify(preview);
    assert.doesNotMatch(serialized, /private body|private-id|inner-.*confirmation|\/Users\//i);
    const result = await controller.confirm(action, preview.confirmationToken);
    assert.equal(result.action, action);
  }
  assert.deepEqual(calls.filter(call => call[0] === 'restart').length, 1);
  assert.deepEqual(calls.filter(call => call[0] === 'repair').length, 1);
  assert.deepEqual(calls.filter(call => call[0] === 'owner' && call[1] === 'remove').length, 1);
  assert.deepEqual(calls.filter(call => call[0] === 'jobs' && call[1] === 'purge').length, 1);
  assert.deepEqual(calls.filter(call => call[0] === 'messages' && call[1] === 'purge').length, 1);
  assert.equal(auditRecords.length, 5);
  assert.doesNotMatch(JSON.stringify(auditRecords), /confirmationToken|private body|private-id|pid|secret/i);
});

test('tokens are single-use, action-bound, expiring, and invalidated by connection changes', async t => {
  let now = 1000;
  const { controller } = fixture(t, { controllerOptions: { now: () => now, ttlMs: 60_000 } });
  const first = await controller.preview('cleanup_activity', { scope: 'owner', identity: 'CODEX1' });
  await assert.rejects(controller.confirm('cleanup_messages', first.confirmationToken), /confirmation_invalid/);
  await controller.confirm('cleanup_activity', first.confirmationToken);
  await assert.rejects(controller.confirm('cleanup_activity', first.confirmationToken), /confirmation_invalid/);
  const expired = await controller.preview('cleanup_activity', { scope: 'owner', identity: 'CODEX1' });
  now += 60_001;
  await assert.rejects(controller.confirm('cleanup_activity', expired.confirmationToken), /confirmation_expired/);
  const disconnected = await controller.preview('cleanup_activity', { scope: 'owner', identity: 'CODEX1' });
  controller.setConnectionGeneration('replacement');
  await assert.rejects(controller.confirm('cleanup_activity', disconnected.confirmationToken), /confirmation_invalid/);
});

test('changed local state rejects confirmation before mutation', async t => {
  let count = 1;
  const { controller, calls } = fixture(t, {
    operations: {
      operatorJobRequest: async (_root, action, details) => {
        calls.push(['jobs', action]);
        return { owner: details.owner, count: count++, byStatus: { completed: count }, byOwner: { CODEX1: count }, confirmation: `inner-${count}` };
      }
    }
  });
  const preview = await controller.preview('cleanup_activity', { scope: 'owner', identity: 'CODEX1' });
  await assert.rejects(controller.confirm('cleanup_activity', preview.confirmationToken), /state_changed/);
  assert.equal(calls.filter(call => call[1] === 'purge').length, 0);
});

test('mutation mutex rejects a concurrent confirmation without consuming its token', async t => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const { controller } = fixture(t, {
    operations: { restartRelay: async () => { await blocked; return { ok: true }; } }
  });
  const first = await controller.preview('restart_relay', {});
  const second = await controller.preview('cleanup_activity', { scope: 'owner', identity: 'CODEX1' });
  const pending = controller.confirm('restart_relay', first.confirmationToken);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(controller.confirm('cleanup_activity', second.confirmationToken), /action_busy/);
  release();
  await pending;
  // A completed mutation invalidates every older preview.
  await assert.rejects(controller.confirm('cleanup_activity', second.confirmationToken), /confirmation_invalid/);
});

test('audit writer keeps a private bounded content-free journal', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-admin-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'audit.jsonl');
  const audit = createLocalAuditWriter({ filePath, maximum: 2 });
  audit.preflight();
  audit.write({ actionId: '1', action: 'restart_relay', outcome: 'completed' });
  audit.write({ actionId: '2', action: 'cleanup_activity', outcome: 'completed' });
  audit.write({ actionId: '3', action: 'cleanup_messages', outcome: 'rejected' });
  assert.equal(fs.statSync(filePath).mode & 0o077, 0);
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(item => item.actionId), ['2', '3']);
});

test('restart refuses active work and an audit preflight failure prevents mutation', async t => {
  let restarts = 0;
  const active = fixture(t, {
    operations: {
      readJobRecords: () => [{
        jobId: 'wake_10000000-0000-4000-8000-000000000099',
        _recordName: 'wake_10000000-0000-4000-8000-000000000099',
        owner: 'CODEX1', status: 'running'
      }],
      restartRelay: () => { restarts += 1; return { ok: true }; }
    }
  });
  await assert.rejects(active.controller.preview('restart_relay', {}), /active_work/);
  assert.equal(restarts, 0);

  const auditFailure = fixture(t, {
    operations: { restartRelay: () => { restarts += 1; return { ok: true }; } },
    audit: { preflight() { throw new Error('audit unavailable'); }, write() {} }
  });
  const preview = await auditFailure.controller.preview('restart_relay', {});
  await assert.rejects(auditFailure.controller.confirm('restart_relay', preview.confirmationToken), /audit unavailable/);
  assert.equal(restarts, 0);
});

test('all-owner scopes require their independent gates even when exact cleanup is enabled', async t => {
  const exactOnly = fixture(t);
  await assert.rejects(exactOnly.controller.preview('cleanup_activity', { scope: 'all' }), /scope_disabled/);
  await assert.rejects(exactOnly.controller.preview('cleanup_messages', { scope: 'all' }), /scope_disabled/);
  const allEnabled = fixture(t, { gates: allGates({ cleanup_activity_all: true, cleanup_messages_all: true }) });
  assert.equal((await allEnabled.controller.preview('cleanup_activity', { scope: 'all' })).summary.scope, 'all');
  assert.equal((await allEnabled.controller.preview('cleanup_messages', { scope: 'all' })).summary.global, true);
});
