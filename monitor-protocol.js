'use strict';

const { createHmac, randomBytes, timingSafeEqual } = require('crypto');

const PROTOCOL_VERSION = 1;
const MESSAGE_TYPES = new Set([
  'agent_hello', 'agent_heartbeat', 'snapshot', 'event',
  'preview_request', 'preview_result', 'confirm_request', 'action_result',
  'protocol_error'
]);
const READ_ONLY_AGENT_TYPES = new Set(['agent_hello', 'agent_heartbeat', 'snapshot', 'event', 'protocol_error']);
const FORBIDDEN_KEYS = new Set([
  'content', 'message', 'messages', 'prompt', 'reasoning', 'command', 'commands',
  'toolInput', 'toolOutput', 'toolArguments', 'stdout', 'stderr', 'argv', 'args',
  'path', 'cwd', 'pid', 'spawnPid', 'secret', 'adminSecret', 'resultSecret'
]);
const LOCAL_PATH = /(^|[\s(])\/(?!\/)[^\s),;]*/;
const CREDENTIAL = /\b(?:sk-[A-Za-z0-9_-]{12,}|[A-Fa-f0-9]{32,}|[A-Za-z0-9_+=-]{40,})\b/;

function createChallenge() {
  return randomBytes(32).toString('base64url');
}

function handshakeMac(secret, installationId, challenge) {
  return createHmac('sha256', secret)
    .update(`${PROTOCOL_VERSION}\0${installationId}\0${challenge}`)
    .digest('base64url');
}

function verifyHandshakeMac(secret, installationId, challenge, mac) {
  if (![installationId, challenge, mac].every(value => typeof value === 'string')) return false;
  const expected = Buffer.from(handshakeMac(secret, installationId, challenge));
  const received = Buffer.from(mac);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function envelope(type, sequence, payload = {}, generatedAt = new Date().toISOString()) {
  if (!MESSAGE_TYPES.has(type)) throw new Error('Unknown monitor protocol message type');
  return { version: PROTOCOL_VERSION, type, sequence, generatedAt, payload };
}

function parseEnvelope(raw, options = {}) {
  let value;
  try { value = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)); } catch {
    throw new Error('Monitor protocol message is not valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Monitor protocol envelope must be an object');
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'generatedAt,payload,sequence,type,version') throw new Error('Monitor protocol envelope has unknown fields');
  if (value.version !== PROTOCOL_VERSION) throw new Error('Unsupported monitor protocol version');
  if (!MESSAGE_TYPES.has(value.type)) throw new Error('Unknown monitor protocol message type');
  if (options.readOnlyAgent && !READ_ONLY_AGENT_TYPES.has(value.type)) throw new Error('Mutating monitor protocol messages are disabled');
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) throw new Error('Invalid monitor protocol sequence');
  if (typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))) throw new Error('Invalid monitor protocol timestamp');
  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) throw new Error('Invalid monitor protocol payload');
  return value;
}

function assertDataMinimized(value, trail = 'payload') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertDataMinimized(item, `${trail}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) throw new Error(`Forbidden monitor field: ${trail}.${key}`);
      assertDataMinimized(item, `${trail}.${key}`);
    }
    return;
  }
  const canonicalJobId = trail.endsWith('.jobId') && /^wake_[0-9a-f-]{36}$/.test(value);
  if (typeof value === 'string' && (LOCAL_PATH.test(value) || (!canonicalJobId && CREDENTIAL.test(value)))) {
    throw new Error(`Forbidden monitor value: ${trail}`);
  }
}

function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== 1) throw new Error('Invalid monitor snapshot');
  if (!Array.isArray(snapshot.activeWork) || !Array.isArray(snapshot.recentWork) || !Array.isArray(snapshot.identities)) {
    throw new Error('Monitor snapshot collections are invalid');
  }
  assertDataMinimized(snapshot);
  return snapshot;
}

module.exports = {
  MESSAGE_TYPES,
  PROTOCOL_VERSION,
  READ_ONLY_AGENT_TYPES,
  assertDataMinimized,
  createChallenge,
  envelope,
  handshakeMac,
  parseEnvelope,
  validateSnapshot,
  verifyHandshakeMac
};
