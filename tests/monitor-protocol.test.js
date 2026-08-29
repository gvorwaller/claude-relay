'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertDataMinimized, envelope, handshakeMac, parseEnvelope, validateSnapshot,
  verifyHandshakeMac
} = require('../monitor-protocol');

test('agent handshake is installation- and nonce-bound with constant-shape verification', () => {
  const secret = 'test-secret-with-at-least-thirty-two-bytes';
  const mac = handshakeMac(secret, 'home-relay', 'challenge-a');
  assert.equal(verifyHandshakeMac(secret, 'home-relay', 'challenge-a', mac), true);
  assert.equal(verifyHandshakeMac(secret, 'other-relay', 'challenge-a', mac), false);
  assert.equal(verifyHandshakeMac(secret, 'home-relay', 'challenge-b', mac), false);
  assert.equal(verifyHandshakeMac('wrong-secret', 'home-relay', 'challenge-a', mac), false);
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
