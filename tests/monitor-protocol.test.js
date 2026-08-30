'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertDataMinimized, envelope, handshakeMac, parseEnvelope, validateSnapshot,
  validateAgentCapabilities, validateAgentCommand, validateAgentResult, verifyHandshakeMac
} = require('../monitor-protocol');

test('agent handshake is installation- and nonce-bound with constant-shape verification', () => {
  const secret = 'test-secret-with-at-least-thirty-two-bytes';
  const mac = handshakeMac(secret, 'home-relay', 'challenge-a');
  assert.equal(verifyHandshakeMac(secret, 'home-relay', 'challenge-a', mac), true);
  assert.equal(verifyHandshakeMac(secret, 'other-relay', 'challenge-a', mac), false);
  assert.equal(verifyHandshakeMac(secret, 'home-relay', 'challenge-b', mac), false);
  assert.equal(verifyHandshakeMac('wrong-secret', 'home-relay', 'challenge-a', mac), false);
});

test('Phase 4 capabilities and commands use sorted enums and action-specific exact schemas', () => {
  assert.deepEqual(validateAgentCapabilities({
    revision: 1, actions: ['cleanup_activity', 'restart_relay']
  }).actions, ['cleanup_activity', 'restart_relay']);
  assert.throws(() => validateAgentCapabilities({
    revision: 1, actions: ['restart_relay', 'cleanup_activity']
  }), /capabilities/);
  assert.throws(() => validateAgentCapabilities({ revision: 1, actions: ['shell'] }), /capabilities/);
  const requestId = 'request_admin_1';
  assert.deepEqual(validateAgentCommand('preview_request', {
    requestId, action: 'cleanup_activity', target: { scope: 'owner', identity: 'CODEX1' }
  }).target, { scope: 'owner', identity: 'CODEX1' });
  assert.throws(() => validateAgentCommand('preview_request', {
    requestId, action: 'restart_relay', target: { label: 'other-service' }
  }), /restart target/);
  assert.throws(() => validateAgentCommand('preview_request', {
    requestId, action: 'cleanup_messages', target: { scope: 'identity', identity: '../CC1' }
  }), /cleanup target/);
  assert.equal(validateAgentCommand('confirm_request', {
    requestId, action: 'remove_identity', confirmationToken: 'Q'.repeat(43)
  }).action, 'remove_identity');
});

test('action protocol accepts only exact minimized stop payloads', () => {
  const jobId = 'wake_10000000-0000-4000-8000-000000000001';
  const requestId = 'request_12345678';
  const confirmationToken = 'A'.repeat(43);
  assert.equal(validateAgentCommand('preview_request', {
    requestId, action: 'stop_delegate', jobId
  }).jobId, jobId);
  assert.equal(validateAgentCommand('confirm_request', {
    requestId, action: 'stop_delegate', jobId, confirmationToken
  }).confirmationToken, confirmationToken);
  const preview = {
    action: 'stop_delegate', jobId, owner: 'CC1', processAlive: true,
    consequences: ['Exact process group stops.', 'Job becomes interrupted.', 'Durable mail remains.'],
    confirmationToken, expiresAt: '2026-08-29T16:01:00.000Z'
  };
  assert.equal(validateAgentResult('preview_result', { requestId, ok: true, preview }).preview, preview);
  assert.throws(() => validateAgentCommand('confirm_request', {
    requestId, action: 'stop_delegate', jobId, confirmationToken, pid: 42
  }), /Invalid confirm request payload/);
  assert.throws(() => validateAgentCommand('preview_request', {
    requestId, action: 'shell', jobId
  }), /Invalid monitor agent command/);
  assert.throws(() => validateAgentResult('preview_result', {
    requestId, ok: true, preview: { ...preview, path: '/Users/private' }
  }), /Invalid stop preview payload/);
});

test('protocol rejects unknown fields, versions, message types, and read-only mutations', () => {
  const valid = envelope('agent_heartbeat', 1, {});
  assert.equal(parseEnvelope(JSON.stringify(valid), { readOnlyAgent: true }).sequence, 1);
  assert.throws(() => parseEnvelope(JSON.stringify({ ...valid, extra: true })), /unknown fields/);
  assert.throws(() => parseEnvelope(JSON.stringify({ ...valid, version: 2 })), /version/);
  assert.throws(() => parseEnvelope(JSON.stringify({ ...valid, type: 'shell' })), /message type/);
  assert.throws(() => parseEnvelope(JSON.stringify(envelope('confirm_request', 2, {})), { readOnlyAgent: true }), /disabled/);
});

test('snapshot validation rejects forbidden raw fields, values, and local paths', () => {
  const base = { version: 1, generatedAt: new Date().toISOString(), health: {}, activeWork: [], recentWork: [], identities: [] };
  assert.equal(validateSnapshot(base), base);
  assert.throws(() => validateSnapshot({ ...base, prompt: 'private' }), /Forbidden monitor field/);
  assert.throws(() => validateSnapshot({ ...base, recentWork: [{ summary: 'read /Users/person/key' }] }), /Forbidden monitor value/);
  assert.throws(() => validateSnapshot({ ...base, recentWork: [{ summary: 'read /usr/local/private' }] }), /Forbidden monitor value/);
  assert.throws(() => assertDataMinimized({ nested: { stdout: 'private' } }), /Forbidden monitor field/);
  assert.throws(() => assertDataMinimized({ summary: 'sk-thiscredentialmustnotleavehost' }), /Forbidden monitor value/);
  assert.throws(() => assertDataMinimized({ summary: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop' }), /Forbidden monitor value/);
});
