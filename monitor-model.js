'use strict';

const fs = require('fs');
const path = require('path');
const { createHash, randomBytes } = require('crypto');
const {
  healthAssessment, operatorTerminateDelegate, readJobRecords, relayTopology
} = require('./monitor-control');
const { isTransientOwnerLabel } = require('./capabilities');

const ACTIVE_JOB_STATES = new Set(['spawned', 'running']);
const CANONICAL_JOB_ID = /^wake_[0-9a-f-]{36}$/;
const STOP_CONFIRMATION_TTL_MS = 60_000;
const ACTIVITY_LABELS = Object.freeze({
  analyzing: 'Analyzing request',
  reading_message: 'Reading relay message',
  reading_files: 'Reading files',
  running_command: 'Running a command',
  using_tool: 'Using a tool',
  updating_files: 'Updating files',
  sending_reply: 'Sending relay reply',
  preparing_response: 'Preparing response',
  waiting: 'Waiting',
  finishing: 'Finishing delegated run',
  error: 'Codex reported an error'
});

function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function safeText(value, maximum = 2000) {
  if (typeof value !== 'string') return null;
  return value
    .slice(0, maximum)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|[A-Fa-f0-9]{32,}|[A-Za-z0-9_+=-]{40,})\b/g, '[redacted credential]')
    .replace(/\b(password|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/(^|[\s(])\/(?!\/)[^\s),;]*/g, '$1[local path]');
}

function ageMs(value, now) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? Math.max(0, now - parsed) : null;
}

function formatAge(value) {
  const seconds = Math.max(0, Math.round((Number(value) || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function processGroupAlive(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  const kill = options.kill || process.kill.bind(process);
  try {
    kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function projectJob(job, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const activity = Array.isArray(job.activity) ? job.activity : [];
  const latestEvent = [...activity].reverse().find(event => timestamp(event?.at));
  const requestedAt = timestamp(job.requestedAt);
  const startedAt = timestamp(job.startedAt);
  const lastActivityAt = timestamp(latestEvent?.at) || startedAt || requestedAt;
  const active = ACTIVE_JOB_STATES.has(job.status);
  const lastActivityAgeMs = ageMs(lastActivityAt, now);
  const stalled = !active || lastActivityAgeMs === null ? null
    : lastActivityAgeMs >= 20 * 60 * 1000 ? 'possibly_stuck'
      : lastActivityAgeMs >= 10 * 60 * 1000 ? 'inactive' : null;

  return {
    jobId: typeof job.jobId === 'string' ? job.jobId : null,
    owner: typeof job.owner === 'string' ? job.owner : 'unknown',
    requester: typeof job.from === 'string' ? job.from : 'unknown',
    status: typeof job.status === 'string' ? job.status : 'unknown',
    requestedAt,
    startedAt,
    completedAt: timestamp(job.completedAt || job.reportedAt),
    requestedAgeMs: ageMs(requestedAt, now),
    runAgeMs: ageMs(startedAt || requestedAt, now),
    lastActivityAt,
    lastActivityAgeMs,
    latestActivity: latestEvent
      ? { type: ACTIVITY_LABELS[latestEvent.type] ? latestEvent.type : 'working', label: ACTIVITY_LABELS[latestEvent.type] || 'Working' }
      : null,
    processAlive: active ? processGroupAlive(job.spawnPid, options) : false,
    stalled,
    actions: { stopDelegate: active && CANONICAL_JOB_ID.test(job.jobId || '') },
    outbound: Array.isArray(job.outbound) ? job.outbound.map(item => ({
      to: typeof item?.to === 'string' ? item.to : 'unknown',
      delivered: item?.delivered === true,
      at: timestamp(item?.at)
    })) : []
  };
}

function stopDelegateState(dataRoot, jobId, options = {}) {
  const job = readJobRecords(dataRoot).find(record => record.jobId === jobId && record._recordName === jobId);
  if (!job || !ACTIVE_JOB_STATES.has(job.status) || !CANONICAL_JOB_ID.test(jobId || '')) {
    throw new Error('That delegate is no longer active');
  }
  const projected = projectJob(job, options);
  const latestActivityAt = projected.lastActivityAt;
  const fingerprint = createHash('sha256').update(JSON.stringify({
    action: 'stop_delegate', jobId, owner: job.owner, status: job.status, spawnPid: job.spawnPid,
    serverInstance: job.serverInstance, requestedAt: job.requestedAt,
    startedAt: job.startedAt, latestActivityAt, processAlive: projected.processAlive
  })).digest('base64url');
  return { job, projected, fingerprint };
}

function createStopDelegateController(dataRoot, options = {}) {
  const now = options.now || (() => Date.now());
  const confirmations = new Map();
  const terminate = options.operatorTerminateDelegate || operatorTerminateDelegate;
  const tokenFactory = options.tokenFactory || (() => randomBytes(32).toString('base64url'));
  const ttlMs = options.ttlMs || STOP_CONFIRMATION_TTL_MS;

  function prune() {
    for (const [token, preview] of confirmations) {
      if (preview.expiresAtMs <= now()) confirmations.delete(token);
    }
  }

  function preview(jobId) {
    prune();
    const state = stopDelegateState(dataRoot, jobId, { ...options, now: now() });
    const confirmationToken = tokenFactory();
    const expiresAtMs = now() + ttlMs;
    confirmations.set(confirmationToken, {
      jobId, owner: state.job.owner, fingerprint: state.fingerprint, expiresAtMs
    });
    return {
      action: 'stop_delegate', jobId, owner: state.job.owner,
      processAlive: state.projected.processAlive,
      consequences: [
        'The exact active delegate process group will be terminated.',
        'The delegate job will become interrupted.',
        'Its audit record and durable relay mail will be preserved.'
      ],
      confirmationToken,
      expiresAt: new Date(expiresAtMs).toISOString()
    };
  }

  async function confirm(jobId, confirmationToken) {
    const previewed = confirmations.get(confirmationToken);
    if (previewed) confirmations.delete(confirmationToken);
    if (!previewed || previewed.jobId !== jobId) throw new Error('Confirmation is invalid or already used');
    if (previewed.expiresAtMs <= now()) throw new Error('Confirmation has expired');
    const current = stopDelegateState(dataRoot, jobId, { ...options, now: now() });
    if (current.job.owner !== previewed.owner || current.fingerprint !== previewed.fingerprint) {
      throw new Error('Delegate state changed; preview it again before confirming');
    }
    const result = await terminate(dataRoot, jobId, options.operatorOptions || {});
    return {
      action: 'stop_delegate', jobId, owner: current.job.owner,
      status: 'interrupted', signaled: result.signaled === true,
      completedAt: new Date(now()).toISOString()
    };
  }

  return { confirmations, preview, confirm };
}

function projectJobDetail(job, options = {}) {
  const overview = projectJob(job, options);
  return {
    ...overview,
    activity: (Array.isArray(job.activity) ? job.activity : [])
      .filter(event => timestamp(event?.at))
      .map(event => ({
        at: timestamp(event.at),
        type: ACTIVITY_LABELS[event.type] ? event.type : 'working',
        label: ACTIVITY_LABELS[event.type] || 'Working'
      })),
    summary: safeText(job.summary, 4000),
    changes: safeText(job.changes, 4000),
    verification: (Array.isArray(job.verification) ? job.verification : [])
      .slice(0, 20).map(item => safeText(item, 500)).filter(Boolean),
    error: ['failed', 'interrupted', 'exited_no_delegate'].includes(job.status)
      ? { status: job.status, reason: safeText(job.reason, 500) || 'No bounded failure reason was captured.' }
      : null
  };
}

function projectJobs(records, options = {}) {
  const owner = options.owner || null;
  const limit = Number.isInteger(options.limit) && options.limit >= 0 ? options.limit : 20;
  return [...records]
    .filter(job => !owner || job.owner === owner)
    .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))
    .slice(0, limit)
    .map(job => projectJob(job, options));
}

function projectHealth(dataRoot, options = {}) {
  const { status, assessment } = healthAssessment(dataRoot);
  const pendingOwnerLabels = Array.isArray(status?.metrics?.ownersPendingLabels)
    ? status.metrics.ownersPendingLabels.filter(label => typeof label === 'string') : [];
  let alerts = status?.alerts;
  if (!status) {
    try { alerts = JSON.parse(fs.readFileSync(path.join(dataRoot, 'runtime-status.json'), 'utf8')).alerts; } catch {}
  }
  return {
    state: status ? (assessment.ok ? 'healthy' : 'needs_attention') : 'offline',
    ok: assessment.ok,
    results: assessment.results.map(result => ({
      level: result.level,
      code: result.code,
      text: !options.includeLocalDetails && result.code === 'daemon_running'
        ? 'Relay daemon is running' : result.text
    })),
    metrics: status?.metrics ? {
      jobsTotal: Number(status?.metrics?.jobsTotal) || 0,
      jobsUnreported: Number(status?.metrics?.jobsUnreported) || 0,
      ownersPending: Number(status?.metrics?.ownersPending) || 0,
      ownersPendingLabels: pendingOwnerLabels
    } : null,
    alerts: Array.isArray(alerts)
      ? alerts.filter(alert => alert?.code === 'job_store_at_capacity').map(alert => ({ code: alert.code }))
      : []
  };
}

function readMonitorModel(dataRoot, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  return {
    generatedAt: new Date(now).toISOString(),
    health: projectHealth(dataRoot, options),
    jobs: projectJobs(readJobRecords(dataRoot), { ...options, now })
  };
}

function projectIdentities(topology) {
  const peers = new Set((Array.isArray(topology?.peers) ? topology.peers : [])
    .filter(identity => !isTransientOwnerLabel(identity)));
  const pending = new Set(Array.isArray(topology?.pendingOwnerLabels) ? topology.pendingOwnerLabels : []);
  const sessions = topology?.sessions && typeof topology.sessions === 'object' ? topology.sessions : {};
  const registered = topology?.registeredSessions && typeof topology.registeredSessions === 'object'
    ? topology.registeredSessions : {};
  return [...new Set([...Object.keys(registered), ...Object.keys(sessions)])]
    .filter(identity => !isTransientOwnerLabel(identity))
    .sort()
    .map(identity => {
      const meta = sessions[identity] || registered[identity] || {};
      return {
        identity,
        live: peers.has(identity),
        host: typeof meta.host === 'string' ? meta.host : null,
        cwdBasename: typeof meta.cwd === 'string' ? path.basename(meta.cwd) : null,
        source: typeof meta.source === 'string' ? meta.source : null,
        credentialWarning: pending.has(identity)
      };
    });
}

async function buildMonitorSnapshot(dataRoot, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const records = readJobRecords(dataRoot)
    .filter(job => CANONICAL_JOB_ID.test(job.jobId || '') && job._recordName === job.jobId);
  const details = projectJobs(records, { ...options, now, limit: options.limit || 100 })
    .map(projected => {
      const raw = records.find(job => job.jobId === projected.jobId);
      return projectJobDetail(raw, { ...options, now });
    });
  let topology = options.topology;
  let topologyError = null;
  if (topology === undefined) {
    try {
      topology = await (options.relayTopology || relayTopology)(dataRoot, options.topologyOptions);
    } catch (error) {
      topology = {};
      topologyError = safeText(error?.message, 200) || 'Live relay topology is unavailable.';
    }
  }
  return {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    health: projectHealth(dataRoot, options),
    activeWork: details.filter(job => ACTIVE_JOB_STATES.has(job.status)),
    recentWork: details.filter(job => !ACTIVE_JOB_STATES.has(job.status)),
    identities: projectIdentities(topology),
    topologyError
  };
}

module.exports = {
  ACTIVITY_LABELS,
  buildMonitorSnapshot,
  createStopDelegateController,
  formatAge,
  processGroupAlive,
  projectHealth,
  projectIdentities,
  projectJob,
  projectJobDetail,
  projectJobs,
  readMonitorModel,
  safeText
};
