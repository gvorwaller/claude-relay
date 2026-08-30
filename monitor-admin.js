'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash, randomBytes, randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const {
  ADMIN_ACTIONS, GATE_NAMES, actionGates, enabledActions, exactIdentity, validateAdminTarget
} = require('./monitor-admin-schema');
const {
  activeJobChoices, healthAssessment, operatorJobRequest, operatorMessageRequest,
  operatorOwnerRepair, operatorOwnerRemoval, operatorRemovableOwners,
  pendingOwnerLabels, readJobRecords, readMessageRecords, relayTopology, restartRelay
} = require('./monitor-control');

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const TERMINAL = new Set(['completed', 'failed', 'interrupted', 'exited_no_delegate', 'reported']);
const TTL_MS = 60_000;

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}

function dateRange(records, getter) {
  const values = records.map(getter).filter(value => typeof value === 'string' && Number.isFinite(Date.parse(value))).sort();
  return { oldestAt: values[0] || null, newestAt: values.at(-1) || null };
}

function countBy(records, getter) {
  const counts = {};
  for (const record of records) {
    const key = getter(record);
    if (typeof key === 'string' && key) counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function defaultAuditPath() {
  return path.join(os.homedir(), '.config', 'claude-relay-monitor', 'admin-actions.jsonl');
}

function inspectRelayService(options = {}) {
  const uid = options.uid === undefined
    ? (typeof process.getuid === 'function' ? process.getuid() : null) : options.uid;
  if (!Number.isInteger(uid) || uid < 0) return 'unknown';
  const run = options.spawnSync || spawnSync;
  const result = run('launchctl', ['print', `gui/${uid}/com.claude-relay`], { encoding: 'utf8' });
  if (!result.error && result.status === 0) return 'running';
  const failure = String(result.stderr || result.error?.message || '');
  return /could not find service|not found|no such process/i.test(failure) ? 'missing_registration' : 'stopped';
}

function createLocalAuditWriter(options = {}) {
  const filePath = options.filePath || defaultAuditPath();
  const maximum = options.maximum || 100;
  function write(record) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    let records = [];
    try {
      records = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
        .map(line => JSON.parse(line)).slice(-(maximum - 1));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    records.push(record);
    const temporary = `${filePath}.${process.pid}.tmp`;
    const handle = fs.openSync(temporary, 'w', 0o600);
    try {
      fs.writeSync(handle, `${records.map(item => JSON.stringify(item)).join('\n')}\n`);
      fs.fsyncSync(handle);
    } finally { fs.closeSync(handle); }
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
  }
  function preflight() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const handle = fs.openSync(filePath, 'a', 0o600);
    fs.closeSync(handle);
    fs.chmodSync(filePath, 0o600);
  }
  return { filePath, preflight, write };
}

function createAdminController(dataRoot, options = {}) {
  const now = options.now || (() => Date.now());
  const gates = options.gates || actionGates(options.env);
  const installationId = options.installationId || 'local-relay';
  const tokenFactory = options.tokenFactory || (() => randomBytes(32).toString('base64url'));
  const audit = options.audit || createLocalAuditWriter(options.auditOptions);
  const ops = {
    activeJobChoices, healthAssessment, operatorJobRequest, operatorMessageRequest,
    operatorOwnerRepair, operatorOwnerRemoval, operatorRemovableOwners,
    pendingOwnerLabels, readJobRecords, readMessageRecords, relayTopology, restartRelay,
    ...options.operations
  };
  const confirmations = new Map();
  let mutationActive = false;
  let connectionGeneration = options.connectionGeneration || randomUUID();

  function setConnectionGeneration(value) {
    connectionGeneration = String(value || randomUUID());
    confirmations.clear();
  }

  function prune() {
    for (const [token, entry] of confirmations) if (entry.expiresAtMs <= now()) confirmations.delete(token);
  }

  function requireEnabled(action) {
    if (!gates[action]) throw new Error('action_disabled');
  }

  async function buildState(action, target) {
    validateAdminTarget(action, target, gates);
    if (action === 'restart_relay') {
      if (options.jobStoreReadable && !options.jobStoreReadable()) throw new Error('job_store_unreadable');
      if (!options.jobStoreReadable) {
        try { fs.readdirSync(path.join(dataRoot, 'jobs')); } catch { throw new Error('job_store_unreadable'); }
      }
      const jobs = ops.readJobRecords(dataRoot);
      if (!Array.isArray(jobs)) throw new Error('job_store_unreadable');
      const active = jobs.filter(job => ['spawned', 'running'].includes(job.status));
      if (active.length) throw new Error('active_work');
      const health = ops.healthAssessment(dataRoot);
      const plistPresent = options.plistPresent ? options.plistPresent() : fs.existsSync(
        options.plistPath || path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.claude-relay.plist'));
      const serviceState = options.serviceState ? await options.serviceState() : inspectRelayService(options.restartOptions);
      const relayHealth = health.status ? (health.assessment.ok ? 'healthy' : 'needs_attention') : 'offline';
      const summary = { serviceState, relayHealth, activeDelegateCount: 0, installedPlistPresent: plistPresent };
      return { summary, binding: summary, local: {} };
    }
    if (action === 'cleanup_activity') {
      const owner = target.scope === 'all' ? 'all' : target.identity;
      const local = await ops.operatorJobRequest(dataRoot, 'preview', { owner }, options.operatorOptions || {});
      const records = ops.readJobRecords(dataRoot).filter(job =>
        (owner === 'all' || job.owner === owner) && TERMINAL.has(job.status));
      const range = dateRange(records, job => job.completedAt || job.reportedAt || job.requestedAt);
      const summary = {
        scope: target.scope, identity: owner === 'all' ? null : owner,
        eligibleCount: Number(local.count) || 0,
        countsByStatus: { ...(local.byStatus || {}) }, countsByOwner: { ...(local.byOwner || {}) },
        ...range, activeWorkPreserved: true
      };
      return { summary, binding: { owner, confirmation: local.confirmation, count: summary.eligibleCount }, local: { owner, confirmation: local.confirmation } };
    }
    if (action === 'repair_owner_credential') {
      if (!ops.pendingOwnerLabels(dataRoot).includes(target.identity)) throw new Error('identity_not_pending');
      let live = false;
      try { live = (await ops.relayTopology(dataRoot, options.topologyOptions)).peers?.includes(target.identity) === true; } catch {}
      const summary = { identity: target.identity, live, state: 'credential_not_confirmed', consequence: live ? 'live_session_reconnects' : 'credential_ready_next_start' };
      return { summary, binding: summary, local: {} };
    }
    if (action === 'remove_identity') {
      const candidates = await ops.operatorRemovableOwners(dataRoot, options.operatorOptions || {});
      const candidate = candidates.find(item => item.identity === target.identity);
      if (!candidate) throw new Error('identity_not_removable');
      const local = await ops.operatorOwnerRemoval(dataRoot, 'preview', target.identity,
        { disconnectLive: candidate.live === true }, options.operatorOptions || {});
      const summary = {
        identity: target.identity, credentialConfirmed: local.acknowledged === true,
        live: local.live === true, bridgeWillStop: local.live === true,
        lastActivity: typeof local.lastActivity === 'string' ? local.lastActivity : null,
        messagesPreserved: true, completedActivityPreserved: true
      };
      return { summary, binding: { ...summary, confirmation: local.confirmation }, local: { confirmation: local.confirmation, disconnectLive: local.live === true } };
    }
    const owner = target.scope === 'all' ? 'all' : target.identity;
    const local = await ops.operatorMessageRequest(dataRoot, 'preview', { owner }, options.operatorOptions || {});
    const records = ops.readMessageRecords(dataRoot).filter(message => owner === 'all' || message.from === owner || message.to === owner);
    const range = dateRange(records, message => message.timestamp);
    const summary = {
      scope: target.scope, identity: owner === 'all' ? null : owner,
      eligibleCount: Number(local.count) || 0, countsByIdentity: { ...(local.byIdentity || {}) },
      countsByUtcDate: countBy(records, message => message.timestamp.slice(0, 10)),
      ...range, global: owner === 'all'
    };
    return { summary, binding: { owner, confirmation: local.confirmation, count: summary.eligibleCount }, local: { owner, confirmation: local.confirmation } };
  }

  const CONSEQUENCES = {
    restart_relay: ['Relay clients may briefly reconnect.', 'Messages and activity are preserved.', 'The monitor agent is not restarted.'],
    cleanup_activity: ['Only completed activity is removed.', 'Active delegated work is preserved.', 'Deleted activity cannot be recovered here.'],
    repair_owner_credential: ['The replacement credential remains local.', 'Messages, activity, and the identity name are preserved.'],
    remove_identity: ['The identity must enroll again before future use.', 'Messages and completed activity are preserved.'],
    cleanup_messages: ['Conversation history changes for both sides.', 'Deleted message history cannot be recovered here.']
  };

  async function preview(action, target) {
    requireEnabled(action);
    prune();
    const state = await buildState(action, target);
    const confirmationToken = tokenFactory();
    if (!TOKEN.test(confirmationToken)) throw new Error('token_generation_failed');
    const expiresAtMs = now() + (options.ttlMs || TTL_MS);
    confirmations.set(confirmationToken, {
      action, target: structuredClone(target), fingerprint: digest({ installationId, action, target, binding: state.binding }),
      local: state.local, summary: state.summary, expiresAtMs, connectionGeneration
    });
    return { action, summary: state.summary, consequences: CONSEQUENCES[action], confirmationToken, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  async function confirm(action, confirmationToken) {
    requireEnabled(action);
    if (mutationActive) throw new Error('action_busy');
    const entry = confirmations.get(confirmationToken);
    if (!entry || entry.action !== action || entry.connectionGeneration !== connectionGeneration) throw new Error('confirmation_invalid');
    if (entry.expiresAtMs <= now()) { confirmations.delete(confirmationToken); throw new Error('confirmation_expired'); }
    mutationActive = true;
    confirmations.delete(confirmationToken);
    const actionId = randomUUID();
    const requestedAt = new Date(now()).toISOString();
    try {
      const current = await buildState(action, entry.target);
      const fingerprint = digest({ installationId, action, target: entry.target, binding: current.binding });
      if (fingerprint !== entry.fingerprint) throw new Error('state_changed');
      audit.preflight();
      const startedAt = new Date(now()).toISOString();
      let result;
      if (action === 'restart_relay') {
        const response = await ops.restartRelay(options.restartOptions || {});
        if (!response?.ok) throw new Error('restart_failed');
        let healthy = false;
        const deadline = now() + (options.restartObserveMs || 15_000);
        do {
          const observation = options.observeRelayHealth
            ? await options.observeRelayHealth() : ops.healthAssessment(dataRoot);
          healthy = observation?.assessment?.ok === true || observation?.healthy === true;
          if (healthy || now() >= deadline) break;
          await new Promise(resolve => setTimeout(resolve, options.restartPollMs || 250));
        } while (true);
        result = {
          action, outcome: entry.summary.serviceState === 'missing_registration' ? 'repair_requested' : 'restart_requested',
          healthy
        };
      } else if (action === 'cleanup_activity') {
        const response = await ops.operatorJobRequest(dataRoot, 'purge', current.local, options.operatorOptions || {});
        result = { action, outcome: 'completed', scope: entry.summary.scope, identity: entry.summary.identity, removedCount: Number(response.purged) || 0, activeWorkPreserved: true, remainingTerminalCount: Math.max(0, entry.summary.eligibleCount - (Number(response.purged) || 0)) };
      } else if (action === 'repair_owner_credential') {
        await ops.operatorOwnerRepair(dataRoot, entry.target.identity, options.operatorOptions || {});
        result = { action, outcome: entry.summary.live ? 'reconnecting_for_confirmation' : 'ready_for_next_start', identity: entry.target.identity };
      } else if (action === 'remove_identity') {
        const response = await ops.operatorOwnerRemoval(dataRoot, 'remove', entry.target.identity,
          { confirmation: current.local.confirmation, disconnectLive: current.local.disconnectLive }, options.operatorOptions || {});
        result = { action, outcome: 'identity_removed', identity: entry.target.identity, bridgeStopped: response.liveConnectionStopped === true, messagesPreserved: true, completedActivityPreserved: true };
      } else {
        const response = await ops.operatorMessageRequest(dataRoot, 'purge', current.local, options.operatorOptions || {});
        const removed = Number(response.purged) || 0;
        result = { action, outcome: 'completed', scope: entry.summary.scope, identity: entry.summary.identity, removedCount: removed, remainingMessageCount: Math.max(0, ops.readMessageRecords(dataRoot).length), atomicRewrite: true };
      }
      result.completedAt = new Date(now()).toISOString();
      audit.write({
        actionId, action, target: entry.target.identity || entry.target.scope || 'relay',
        previewedCount: Number.isInteger(entry.summary.eligibleCount) ? entry.summary.eligibleCount : null,
        removedCount: Number.isInteger(result.removedCount) ? result.removedCount : null,
        outcome: result.outcome, requestedAt, startedAt, completedAt: result.completedAt,
        connectionGeneration, reconciled: false
      });
      confirmations.clear();
      return result;
    } catch (error) {
      try {
        audit.write({ actionId, action, target: entry.target.identity || entry.target.scope || 'relay', outcome: 'rejected', requestedAt, startedAt: requestedAt, completedAt: new Date(now()).toISOString(), connectionGeneration, reconciled: false });
      } catch {}
      throw error;
    } finally { mutationActive = false; }
  }

  return { confirmations, gates, preview, confirm, setConnectionGeneration, isBusy: () => mutationActive };
}

module.exports = {
  ADMIN_ACTIONS, GATE_NAMES, actionGates, createAdminController, createLocalAuditWriter,
  enabledActions, exactIdentity, inspectRelayService, validateAdminTarget
};
