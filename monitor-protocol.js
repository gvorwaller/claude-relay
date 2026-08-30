'use strict';

const { createHmac, randomBytes, timingSafeEqual } = require('crypto');

const PROTOCOL_VERSION = 1;
const MESSAGE_TYPES = new Set([
  'agent_hello', 'agent_capabilities', 'agent_heartbeat', 'snapshot', 'event',
  'preview_request', 'preview_result', 'confirm_request', 'action_result',
  'protocol_error'
]);
const READ_ONLY_AGENT_TYPES = new Set(['agent_hello', 'agent_capabilities', 'agent_heartbeat', 'snapshot', 'event', 'protocol_error']);
const FORBIDDEN_KEYS = new Set([
  'content', 'message', 'messages', 'prompt', 'reasoning', 'command', 'commands',
  'toolInput', 'toolOutput', 'toolArguments', 'stdout', 'stderr', 'argv', 'args',
  'path', 'cwd', 'pid', 'spawnPid', 'secret', 'adminSecret', 'resultSecret'
]);
const LOCAL_PATH = /(^|[\s(])\/(?!\/)[^\s),;]*/;
const CREDENTIAL = /\b(?:sk-[A-Za-z0-9_-]{12,}|[A-Fa-f0-9]{32,}|[A-Za-z0-9_+=-]{40,})\b/;
const JOB_ID = /^wake_[0-9a-f-]{36}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;
const CONFIRMATION_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CLIENT_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ADMIN_ACTIONS = new Set([
  'restart_relay', 'cleanup_activity', 'repair_owner_credential',
  'remove_identity', 'cleanup_messages'
]);

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
  const canonicalJobId = trail.endsWith('.jobId') && JOB_ID.test(value);
  const confirmationToken = trail.endsWith('.confirmationToken') && CONFIRMATION_TOKEN.test(value);
  if (typeof value === 'string' && (LOCAL_PATH.test(value) || (!canonicalJobId && !confirmationToken && CREDENTIAL.test(value)))) {
    throw new Error(`Forbidden monitor value: ${trail}`);
  }
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    throw new Error(`Invalid ${label} payload`);
  }
}

function validateAgentCommand(type, payload) {
  const isAdmin = ADMIN_ACTIONS.has(payload?.action);
  if (type === 'preview_request') {
    exactKeys(payload, isAdmin ? ['requestId', 'action', 'target'] : ['requestId', 'action', 'jobId'], 'preview request');
  } else if (type === 'confirm_request') {
    exactKeys(payload, isAdmin ? ['requestId', 'action', 'confirmationToken']
      : ['requestId', 'action', 'jobId', 'confirmationToken'], 'confirm request');
    if (!CONFIRMATION_TOKEN.test(payload.confirmationToken || '')) throw new Error('Invalid confirmation token');
  } else {
    throw new Error('Unsupported monitor agent command');
  }
  if (!REQUEST_ID.test(payload.requestId || '')) throw new Error('Invalid monitor agent command');
  if (isAdmin) {
    if (type === 'preview_request') validateAdminTargetShape(payload.action, payload.target);
  } else if (payload.action !== 'stop_delegate' || !JOB_ID.test(payload.jobId || '')) {
    throw new Error('Invalid monitor agent command');
  }
  assertDataMinimized(payload);
  return payload;
}

function validateAgentResult(type, payload) {
  if (type !== 'preview_result' && type !== 'action_result') throw new Error('Unsupported monitor agent result');
  if (!REQUEST_ID.test(payload?.requestId || '') || typeof payload.ok !== 'boolean') {
    throw new Error('Invalid monitor agent result');
  }
  const expected = payload.ok ? ['requestId', 'ok', type === 'preview_result' ? 'preview' : 'result']
    : ['requestId', 'ok', 'error'];
  exactKeys(payload, expected, 'agent result');
  if (payload.ok && type === 'preview_result' && payload.preview?.action === 'stop_delegate') {
    exactKeys(payload.preview, [
      'action', 'jobId', 'owner', 'processAlive', 'consequences', 'confirmationToken', 'expiresAt'
    ], 'stop preview');
    if (payload.preview.action !== 'stop_delegate' || !JOB_ID.test(payload.preview.jobId || '')
      || typeof payload.preview.owner !== 'string' || typeof payload.preview.processAlive !== 'boolean'
      || !Array.isArray(payload.preview.consequences) || payload.preview.consequences.length !== 3
      || !CONFIRMATION_TOKEN.test(payload.preview.confirmationToken || '')
      || !Number.isFinite(Date.parse(payload.preview.expiresAt || ''))) throw new Error('Invalid stop preview');
  }
  if (payload.ok && type === 'action_result' && payload.result?.action === 'stop_delegate') {
    exactKeys(payload.result, ['action', 'jobId', 'owner', 'status', 'signaled', 'completedAt'], 'action result');
    if (payload.result.action !== 'stop_delegate' || !JOB_ID.test(payload.result.jobId || '')
      || typeof payload.result.owner !== 'string' || payload.result.status !== 'interrupted'
      || typeof payload.result.signaled !== 'boolean'
      || !Number.isFinite(Date.parse(payload.result.completedAt || ''))) throw new Error('Invalid action result');
  }
  if (payload.ok && type === 'preview_result' && ADMIN_ACTIONS.has(payload.preview?.action)) {
    exactKeys(payload.preview, ['action', 'summary', 'consequences', 'confirmationToken', 'expiresAt'], 'admin preview');
    if (!payload.preview.summary || typeof payload.preview.summary !== 'object' || Array.isArray(payload.preview.summary)
      || !Array.isArray(payload.preview.consequences) || payload.preview.consequences.length < 2
      || !payload.preview.consequences.every(item => typeof item === 'string' && item.length <= 200)
      || !CONFIRMATION_TOKEN.test(payload.preview.confirmationToken || '')
      || !Number.isFinite(Date.parse(payload.preview.expiresAt || ''))) throw new Error('Invalid admin preview');
    validateAdminSummary(payload.preview.action, payload.preview.summary);
  }
  if (payload.ok && type === 'action_result' && ADMIN_ACTIONS.has(payload.result?.action)) {
    if (!payload.result || typeof payload.result !== 'object' || Array.isArray(payload.result)
      || typeof payload.result.outcome !== 'string' || payload.result.outcome.length > 80
      || !Number.isFinite(Date.parse(payload.result.completedAt || ''))) throw new Error('Invalid admin action result');
    validateAdminActionResult(payload.result);
  }
  if (payload.ok && !ADMIN_ACTIONS.has(payload[type === 'preview_result' ? 'preview' : 'result']?.action)
    && payload[type === 'preview_result' ? 'preview' : 'result']?.action !== 'stop_delegate') {
    throw new Error('Invalid monitor action result');
  }
  if (!payload.ok && (typeof payload.error !== 'string' || !payload.error || payload.error.length > 200)) {
    throw new Error('Invalid agent error result');
  }
  assertDataMinimized(payload);
  return payload;
}

function validCounts(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([key, count]) => CLIENT_ID.test(key) || /^[a-z_]+$/.test(key) || /^\d{4}-\d{2}-\d{2}$/.test(key)
      ? Number.isSafeInteger(count) && count >= 0 : false);
}

function nullableTimestamp(value) {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

function validateAdminSummary(action, summary) {
  if (action === 'restart_relay') {
    exactKeys(summary, ['serviceState', 'relayHealth', 'activeDelegateCount', 'installedPlistPresent'], 'restart summary');
    if (!['running', 'stopped', 'missing_registration', 'unknown'].includes(summary.serviceState)
      || !['healthy', 'needs_attention', 'offline', 'unknown'].includes(summary.relayHealth)
      || summary.activeDelegateCount !== 0 || typeof summary.installedPlistPresent !== 'boolean') throw new Error('Invalid restart summary');
  } else if (action === 'cleanup_activity') {
    exactKeys(summary, ['scope', 'identity', 'eligibleCount', 'countsByStatus', 'countsByOwner', 'oldestAt', 'newestAt', 'activeWorkPreserved'], 'activity cleanup summary');
    if (!['owner', 'all'].includes(summary.scope) || (summary.scope === 'owner' ? !CLIENT_ID.test(summary.identity || '') : summary.identity !== null)
      || !Number.isSafeInteger(summary.eligibleCount) || summary.eligibleCount < 0
      || !validCounts(summary.countsByStatus) || !validCounts(summary.countsByOwner)
      || !nullableTimestamp(summary.oldestAt) || !nullableTimestamp(summary.newestAt)
      || summary.activeWorkPreserved !== true) throw new Error('Invalid activity cleanup summary');
  } else if (action === 'repair_owner_credential') {
    exactKeys(summary, ['identity', 'live', 'state', 'consequence'], 'credential repair summary');
    if (!CLIENT_ID.test(summary.identity || '') || typeof summary.live !== 'boolean'
      || summary.state !== 'credential_not_confirmed'
      || !['live_session_reconnects', 'credential_ready_next_start'].includes(summary.consequence)) throw new Error('Invalid credential repair summary');
  } else if (action === 'remove_identity') {
    exactKeys(summary, ['identity', 'credentialConfirmed', 'live', 'bridgeWillStop', 'lastActivity', 'messagesPreserved', 'completedActivityPreserved'], 'identity removal summary');
    if (!CLIENT_ID.test(summary.identity || '') || !['credentialConfirmed', 'live', 'bridgeWillStop', 'messagesPreserved', 'completedActivityPreserved'].every(key => typeof summary[key] === 'boolean')
      || !nullableTimestamp(summary.lastActivity) || summary.messagesPreserved !== true || summary.completedActivityPreserved !== true) throw new Error('Invalid identity removal summary');
  } else {
    exactKeys(summary, ['scope', 'identity', 'eligibleCount', 'countsByIdentity', 'countsByUtcDate', 'oldestAt', 'newestAt', 'global'], 'message cleanup summary');
    if (!['identity', 'all'].includes(summary.scope) || (summary.scope === 'identity' ? !CLIENT_ID.test(summary.identity || '') : summary.identity !== null)
      || !Number.isSafeInteger(summary.eligibleCount) || summary.eligibleCount < 0
      || !validCounts(summary.countsByIdentity) || !validCounts(summary.countsByUtcDate)
      || !nullableTimestamp(summary.oldestAt) || !nullableTimestamp(summary.newestAt)
      || summary.global !== (summary.scope === 'all')) throw new Error('Invalid message cleanup summary');
  }
}

function validateAdminActionResult(result) {
  const action = result.action;
  if (action === 'restart_relay') {
    exactKeys(result, ['action', 'outcome', 'healthy', 'completedAt'], 'restart result');
    if (!['restart_requested', 'repair_requested'].includes(result.outcome) || typeof result.healthy !== 'boolean') throw new Error('Invalid restart result');
  } else if (action === 'cleanup_activity') {
    exactKeys(result, ['action', 'outcome', 'scope', 'identity', 'removedCount', 'activeWorkPreserved', 'remainingTerminalCount', 'completedAt'], 'activity cleanup result');
    if (result.outcome !== 'completed' || !Number.isSafeInteger(result.removedCount) || result.removedCount < 0
      || !Number.isSafeInteger(result.remainingTerminalCount) || result.remainingTerminalCount < 0 || result.activeWorkPreserved !== true) throw new Error('Invalid activity cleanup result');
  } else if (action === 'repair_owner_credential') {
    exactKeys(result, ['action', 'outcome', 'identity', 'completedAt'], 'credential repair result');
    if (!['reconnecting_for_confirmation', 'ready_for_next_start'].includes(result.outcome) || !CLIENT_ID.test(result.identity || '')) throw new Error('Invalid credential repair result');
  } else if (action === 'remove_identity') {
    exactKeys(result, ['action', 'outcome', 'identity', 'bridgeStopped', 'messagesPreserved', 'completedActivityPreserved', 'completedAt'], 'identity removal result');
    if (result.outcome !== 'identity_removed' || !CLIENT_ID.test(result.identity || '') || typeof result.bridgeStopped !== 'boolean'
      || result.messagesPreserved !== true || result.completedActivityPreserved !== true) throw new Error('Invalid identity removal result');
  } else {
    exactKeys(result, ['action', 'outcome', 'scope', 'identity', 'removedCount', 'remainingMessageCount', 'atomicRewrite', 'completedAt'], 'message cleanup result');
    if (result.outcome !== 'completed' || !Number.isSafeInteger(result.removedCount) || result.removedCount < 0
      || !Number.isSafeInteger(result.remainingMessageCount) || result.remainingMessageCount < 0 || result.atomicRewrite !== true) throw new Error('Invalid message cleanup result');
  }
}

function validateAdminTargetShape(action, target) {
  if (action === 'restart_relay') {
    exactKeys(target, [], 'restart target');
    return target;
  }
  if (action === 'repair_owner_credential' || action === 'remove_identity') {
    exactKeys(target, ['identity'], 'identity target');
    if (!CLIENT_ID.test(target.identity || '') || target.identity === 'all') throw new Error('Invalid identity target');
    return target;
  }
  if (action === 'cleanup_activity' || action === 'cleanup_messages') {
    if (target?.scope === 'all') exactKeys(target, ['scope'], 'cleanup target');
    else {
      exactKeys(target, ['scope', 'identity'], 'cleanup target');
      const expected = action === 'cleanup_activity' ? 'owner' : 'identity';
      if (target.scope !== expected || !CLIENT_ID.test(target.identity || '') || target.identity === 'all') {
        throw new Error('Invalid cleanup target');
      }
    }
    return target;
  }
  throw new Error('Unknown admin action');
}

function validateAgentCapabilities(payload) {
  exactKeys(payload, ['revision', 'actions'], 'agent capabilities');
  if (payload.revision !== 1 || !Array.isArray(payload.actions)
    || payload.actions.some(action => !ADMIN_ACTIONS.has(action))
    || payload.actions.join(',') !== [...new Set(payload.actions)].sort().join(',')) {
    throw new Error('Invalid agent capabilities');
  }
  return payload;
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
  validateAgentCommand,
  validateAgentCapabilities,
  validateAgentResult,
  validateAdminTargetShape,
  validateSnapshot,
  verifyHandshakeMac
};
