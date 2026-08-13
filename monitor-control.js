'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { spawnSync } = require('child_process');
const WebSocket = require('ws');
const { readRuntimeStatus, assessRuntimeStatus } = require('./runtime-status');
const { TERMINAL_RUN_STATES } = require('./delegate-job-store');
const { isTransientOwnerLabel } = require('./capabilities');

const CLIENT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function readJobRecords(dataRoot) {
  const jobsDir = path.join(dataRoot, 'jobs');
  let names = [];
  try { names = fs.readdirSync(jobsDir).filter(name => name.endsWith('.json')); } catch {}
  return names.map(name => {
    try {
      const job = JSON.parse(fs.readFileSync(path.join(jobsDir, name), 'utf8'));
      return job && typeof job === 'object'
        ? { ...job, _recordName: path.basename(name, '.json') }
        : null;
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function selectableJobs(dataRoot, owner = 'all') {
  if (owner !== 'all' && !CLIENT_ID_PATTERN.test(owner)) throw new Error('Invalid identity');
  return readJobRecords(dataRoot)
    .filter(job => /^wake_[0-9a-f-]{36}$/.test(job.jobId || '') && job.jobId === job._recordName)
    .filter(job => owner === 'all' || job.owner === owner)
    .filter(job => TERMINAL_RUN_STATES.has(job.status) || job.status === 'reported')
    .sort((a, b) => String(a.jobId).localeCompare(String(b.jobId)));
}

function previewJobCleanup(dataRoot, owner = 'all') {
  const jobs = selectableJobs(dataRoot, owner);
  const byStatus = {};
  const byOwner = {};
  for (const job of jobs) {
    byStatus[job.status] = (byStatus[job.status] || 0) + 1;
    byOwner[job.owner] = (byOwner[job.owner] || 0) + 1;
  }
  const confirmation = createHash('sha256')
    .update(JSON.stringify({ owner, jobIds: jobs.map(job => job.jobId) }))
    .digest('hex');
  return { owner, count: jobs.length, byStatus, byOwner, confirmation };
}

function purgeJobCleanup(dataRoot, owner, confirmation) {
  const preview = previewJobCleanup(dataRoot, owner);
  if (!confirmation || confirmation !== preview.confirmation) {
    return { ...preview, purged: 0, confirmed: false };
  }
  let purged = 0;
  for (const job of selectableJobs(dataRoot, owner)) {
    try {
      fs.unlinkSync(path.join(dataRoot, 'jobs', `${job.jobId}.json`));
      purged += 1;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return { ...preview, purged, confirmed: true };
}

function ownerChoices(dataRoot) {
  return [...new Set(readJobRecords(dataRoot).map(job => job.owner).filter(Boolean))].sort();
}

function messageOwnerChoices(dataRoot) {
  const identities = new Set();
  const dir = path.join(dataRoot, 'messages');
  let names = [];
  try { names = fs.readdirSync(dir).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)); } catch {}
  for (const name of names) {
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      try {
        const message = JSON.parse(line);
        if (message?.from) identities.add(message.from);
        if (message?.to && message.to !== 'all') identities.add(message.to);
      } catch {}
    }
  }
  return [...identities].sort();
}

function healthAssessment(dataRoot) {
  const status = readRuntimeStatus(path.join(dataRoot, 'runtime-status.json'));
  return { status, assessment: assessRuntimeStatus(status) };
}

function relayTopology(dataRoot, options = {}) {
  const status = readRuntimeStatus(path.join(dataRoot, 'runtime-status.json'));
  if (!status) return Promise.reject(new Error('Relay status is unavailable. Open Health for details.'));
  const WebSocketClient = options.WebSocket || WebSocket;
  return new Promise((resolve, reject) => {
    const socket = new WebSocketClient(`ws://${status.host}:${status.port}`);
    let settled = false;
    let peers = null;
    let sessions = null;
    const finish = (error) => {
      if (settled) return;
      if (!error && (peers === null || sessions === null)) return;
      settled = true; clearTimeout(timer);
      try { socket.close(); } catch {}
      if (error) reject(error); else resolve({
        peers,
        sessions,
        pendingOwnerLabels: Array.isArray(status.metrics?.ownersPendingLabels)
          ? status.metrics.ownersPendingLabels : []
      });
    };
    const timer = setTimeout(() => finish(new Error('The relay did not answer the live-session request.')), options.timeoutMs || 5000);
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'get_peers' }));
      socket.send(JSON.stringify({ type: 'get_sessions' }));
    });
    socket.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.type === 'error') return finish(new Error(message.message));
      if (message.type === 'peers') peers = Array.isArray(message.peers) ? message.peers : [];
      if (message.type === 'sessions') sessions = message.sessions && typeof message.sessions === 'object' ? message.sessions : {};
      finish();
    });
    socket.on('error', error => finish(error));
  });
}

function topologyLines(topology) {
  const peers = Array.isArray(topology?.peers) ? topology.peers : [];
  const sessions = topology?.sessions && typeof topology.sessions === 'object' ? topology.sessions : {};
  const agentPeers = peers.filter(identity => !isTransientOwnerLabel(identity));
  const watcherPeers = peers.filter(isTransientOwnerLabel);
  const pending = new Set(Array.isArray(topology?.pendingOwnerLabels) ? topology.pendingOwnerLabels : []);
  const lines = [
    `Connected agent peers: ${agentPeers.length}`,
    agentPeers.length ? `  ${agentPeers.join(', ')}` : '  No agent identities are connected.',
    `Background message watchers: ${watcherPeers.length}`,
    '',
    'Live agent sessions (the peer connections with their reported details):'
  ];
  const entries = Object.entries(sessions)
    .filter(([identity]) => !isTransientOwnerLabel(identity))
    .sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) lines.push('  No live sessions reported.');
  for (const [identity, meta] of entries) {
    const details = [];
    if (meta.host) details.push(String(meta.host));
    if (meta.source) details.push(String(meta.source));
    if (meta.cwd) details.push(String(meta.cwd));
    if (meta.pid) details.push(`pid ${meta.pid}`);
    if (pending.has(identity)) details.push('owner credential not confirmed');
    lines.push(`  ${identity}${details.length ? ` — ${details.join(' • ')}` : ''}`);
  }
  return lines;
}

function restartRelay(options = {}) {
  const uid = options.uid === undefined
    ? (typeof process.getuid === 'function' ? process.getuid() : null)
    : options.uid;
  if (!Number.isInteger(uid) || uid < 0) return { ok: false, message: 'Cannot determine the local user ID.' };
  const run = options.spawnSync || spawnSync;
  const label = `gui/${uid}/com.claude-relay`;
  let result = run('launchctl', ['kickstart', '-k', label], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const plist = options.plistPath || path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.claude-relay.plist');
    if (fs.existsSync(plist)) {
      const bootstrap = run('launchctl', ['bootstrap', `gui/${uid}`, plist], { encoding: 'utf8' });
      if (!bootstrap.error && bootstrap.status === 0) {
        result = run('launchctl', ['kickstart', '-k', label], { encoding: 'utf8' });
      }
    }
  }
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      message: String(result.stderr || result.error?.message || 'launchctl could not restart the relay').trim()
    };
  }
  return { ok: true, message: 'Relay restart requested. Connected agents will reconnect automatically.' };
}

function operatorJobRequest(dataRoot, action, details = {}, options = {}) {
  return operatorRequest(dataRoot, action === 'preview'
    ? 'operator_preview_delegate_jobs' : 'operator_purge_delegate_jobs', details, options,
  ['delegate_jobs_preview', 'delegate_jobs_purged']);
}

function operatorMessageRequest(dataRoot, action, details = {}, options = {}) {
  return operatorRequest(dataRoot, action === 'preview'
    ? 'operator_preview_messages' : 'operator_purge_messages', details, options,
  ['messages_preview', 'messages_purged']);
}

function operatorOwnerRepair(dataRoot, clientId, options = {}) {
  if (!CLIENT_ID_PATTERN.test(clientId) || clientId === 'all') {
    return Promise.reject(new Error('Choose one exact named identity.'));
  }
  return operatorRequest(dataRoot, 'rotate_owner', {
    clientId,
    force: true
  }, options, ['owner_rotated']);
}

function pendingOwnerLabels(dataRoot) {
  const status = readRuntimeStatus(path.join(dataRoot, 'runtime-status.json'));
  return Array.isArray(status?.metrics?.ownersPendingLabels)
    ? status.metrics.ownersPendingLabels.slice().sort()
    : [];
}

function operatorRequest(dataRoot, type, details = {}, options = {}, responseTypes = []) {
  const status = readRuntimeStatus(path.join(dataRoot, 'runtime-status.json'));
  if (!status) return Promise.reject(new Error('Relay status is unavailable. Open Health for details.'));
  let adminSecret;
  try { adminSecret = fs.readFileSync(path.join(dataRoot, 'admin.secret'), 'utf8').trim(); } catch {}
  if (!adminSecret) return Promise.reject(new Error('Local operator authority is unavailable.'));
  const WebSocketClient = options.WebSocket || WebSocket;
  return new Promise((resolve, reject) => {
    const socket = new WebSocketClient(`ws://${status.host}:${status.port}`);
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { socket.close(); } catch {}
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('The relay did not answer the operator request.')), options.timeoutMs || 5000);
    socket.on('open', () => socket.send(JSON.stringify({ type, adminSecret, ...details })));
    socket.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.type === 'error') finish(new Error(message.message));
      else if (responseTypes.includes(message.type)) finish(null, message);
    });
    socket.on('error', error => finish(error));
  });
}

module.exports = {
  healthAssessment,
  operatorJobRequest,
  operatorMessageRequest,
  operatorOwnerRepair,
  pendingOwnerLabels,
  messageOwnerChoices,
  ownerChoices,
  previewJobCleanup,
  purgeJobCleanup,
  readJobRecords,
  relayTopology,
  restartRelay,
  selectableJobs,
  topologyLines
};
