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
const ACTIVITY_LABELS = {
  analyzing: 'Analyzing request', reading_message: 'Reading relay message',
  reading_files: 'Reading files', running_command: 'Running a command',
  using_tool: 'Using a tool', updating_files: 'Updating files',
  sending_reply: 'Sending relay reply', preparing_response: 'Preparing response',
  waiting: 'Waiting', finishing: 'Finishing delegated run', error: 'Codex reported an error'
};

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

function readMessageRecords(dataRoot) {
  const dir = path.join(dataRoot, 'messages');
  let names = [];
  try { names = fs.readdirSync(dir).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort(); } catch {}
  const messages = [];
  for (const name of names) {
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (message?.id && message?.from && message?.to && message?.timestamp) messages.push(message);
      } catch { /* ignore a partial journal tail */ }
    }
  }
  return messages;
}

function delegateJobDetail(dataRoot, jobId) {
  if (!/^wake_[0-9a-f-]{36}$/.test(jobId || '')) throw new Error('Invalid delegate job');
  const job = readJobRecords(dataRoot).find(record => record.jobId === jobId && record._recordName === jobId);
  if (!job) throw new Error('Delegate job is no longer available');
  const messages = readMessageRecords(dataRoot);
  const byId = new Map(messages.map(message => [message.id, message]));
  return {
    job,
    inbound: job.inboundMessageId ? byId.get(job.inboundMessageId) || null : null,
    outbound: (job.outbound || []).map(evidence => ({
      evidence,
      message: evidence.messageId ? byId.get(evidence.messageId) || null : null
    }))
  };
}

function formatClock(input) {
  if (!input || Number.isNaN(Date.parse(input))) return 'unknown';
  return new Date(input).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function delegateJobReportLines(detail) {
  const { job, inbound, outbound } = detail;
  const start = Date.parse(job.startedAt || job.requestedAt);
  const end = Date.parse(job.completedAt || job.reportedAt || new Date().toISOString());
  const duration = Number.isFinite(start) && Number.isFinite(end)
    ? `${Math.max(0, Math.round((end - start) / 1000))}s` : 'unknown';
  const lines = [
    `${job.owner} ← ${job.from || 'unknown'}  ${String(job.status || 'unknown').toUpperCase()}`,
    `Started: ${formatClock(job.startedAt || job.requestedAt)}  Duration: ${duration}`,
    '', 'INCOMING REQUEST',
    inbound?.content || '(The originating relay message is no longer retained.)',
    '', 'RELAY-OBSERVED RESULT'
  ];
  if (!outbound.length) lines.push('No outbound reply was attributed to this delegate job.');
  for (const { evidence, message } of outbound) {
    lines.push(`Reply to ${evidence.to}: ${message?.content || '(message text no longer retained)'}`);
    lines.push(`Delivery: ${evidence.delivered ? 'Delivered live' : 'Queued'} at ${formatClock(evidence.at || message?.timestamp)}`);
  }
  lines.push('', 'DELEGATE REPORT', job.summary || '(No final delegate report was captured.)');
  if (job.changes) lines.push('', 'CHANGES', job.changes);
  lines.push('', 'VERIFICATION');
  if (Array.isArray(job.verification) && job.verification.length) {
    for (const item of job.verification) lines.push(`• ${item}`);
  } else lines.push('(No verification was reported.)');
  lines.push('', 'SANITIZED ACTIVITY TIMELINE');
  if (!Array.isArray(job.activity) || !job.activity.length) lines.push('(No activity events were captured.)');
  else for (const event of job.activity) lines.push(`${formatClock(event.at)}  ${ACTIVITY_LABELS[event.type] || 'Working'}`);
  if (['failed', 'interrupted', 'exited_no_delegate'].includes(job.status)) {
    lines.push('', 'FAILURE DIAGNOSTIC',
      `Status: ${job.status}${job.exitCode === null || job.exitCode === undefined ? '' : `; exit code ${job.exitCode}`}`,
      job.reason || 'No bounded failure reason was captured.');
  }
  return lines;
}

function scrollWindow(lines, offset, height) {
  const safeLines = Array.isArray(lines) ? lines : [];
  const safeHeight = Math.max(1, Number(height) || 1);
  const maximum = Math.max(0, safeLines.length - safeHeight);
  const start = Math.max(0, Math.min(maximum, Number(offset) || 0));
  return {
    lines: safeLines.slice(start, start + safeHeight),
    offset: start,
    maximum,
    first: safeLines.length ? start + 1 : 0,
    last: Math.min(safeLines.length, start + safeHeight),
    total: safeLines.length
  };
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

function activeJobChoices(dataRoot) {
  return readJobRecords(dataRoot)
    .filter(job => ['spawned', 'running'].includes(job.status))
    .filter(job => /^wake_[0-9a-f-]{36}$/.test(job.jobId || '') && job.jobId === job._recordName)
    .sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
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
  let registeredSessions = {};
  try {
    const registryPath = options.registryPath
      || path.join(path.dirname(dataRoot), 'sessions', 'registry.json');
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) registeredSessions = parsed;
  } catch { /* live topology remains useful when the local registry is absent */ }
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
        registeredSessions,
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
  const registered = topology?.registeredSessions && typeof topology.registeredSessions === 'object'
    ? topology.registeredSessions : {};
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
    if (meta.toolProfile) {
      details.push(meta.toolProfile === 'claude-core'
        ? 'Claude Code lean relay profile'
        : `${meta.toolProfile} relay profile`);
    }
    if (meta.cwd) details.push(String(meta.cwd));
    if (meta.pid) details.push(`pid ${meta.pid}`);
    if (meta.attention?.state === 'relay-wait') {
      const sender = meta.attention.from
        ? `from ${meta.attention.from}`
        : '(any sender)';
      const since = meta.attention.startedAt && !Number.isNaN(Date.parse(meta.attention.startedAt))
        ? ` since ${formatClock(meta.attention.startedAt)}`
        : '';
      details.push(`waiting for relay mail ${sender}${since}`);
    }
    if (pending.has(identity)) details.push('owner credential not confirmed');
    lines.push(`  ${identity}${details.length ? ` — ${details.join(' • ')}` : ''}`);
    if (meta.relayUsage?.calls || meta.relayUsage?.messagesSent) {
      const usage = meta.relayUsage;
      const warnings = [];
      if (usage.largeResults) warnings.push(`${usage.largeResults} large tool result${usage.largeResults === 1 ? '' : 's'}`);
      if (usage.largeMessages) warnings.push(`${usage.largeMessages} large message${usage.largeMessages === 1 ? '' : 's'}`);
      const since = usage.since && !Number.isNaN(Date.parse(usage.since))
        ? ` since ${formatClock(usage.since)}` : '';
      lines.push(`    Relay usage${since}: ${usage.calls || 0} MCP calls • ${formatBytes(usage.resultBytes)} returned • ${usage.messagesSent || 0} messages / ${formatBytes(usage.messageBytes)}${warnings.length ? ` • WARNING: ${warnings.join(', ')}` : ''}`);
    }
  }
  const connected = new Set(peers);
  const idleEntries = Object.entries(registered)
    .filter(([identity]) => !isTransientOwnerLabel(identity) && !connected.has(identity))
    .sort(([a], [b]) => a.localeCompare(b));
  lines.push('', 'Registered idle sessions (known identity and cwd, no live peer connection):');
  if (!idleEntries.length) lines.push('  No registered sessions are idle.');
  for (const [identity, meta] of idleEntries) {
    const details = [];
    if (meta.cwd) details.push(String(meta.cwd));
    if (meta.ended && !Number.isNaN(Date.parse(meta.ended))) {
      details.push(`bridge ended ${formatClock(meta.ended)}`);
    } else details.push('bridge not connected');
    lines.push(`  ${identity} — ${details.join(' • ')}`);
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

function operatorUnusedOwners(dataRoot, options = {}) {
  return operatorRequest(dataRoot, 'operator_list_unused_owners', {}, options, ['unused_owners'])
    .then(result => Array.isArray(result.owners) ? result.owners : []);
}

function operatorRemovableOwners(dataRoot, options = {}) {
  return operatorRequest(dataRoot, 'operator_list_removable_owners', {}, options, ['removable_owners'])
    .then(result => Array.isArray(result.owners) ? result.owners : []);
}

function operatorOwnerRemoval(dataRoot, action, clientId, details = {}, options = {}) {
  if (!CLIENT_ID_PATTERN.test(clientId) || clientId === 'all') {
    return Promise.reject(new Error('Choose one exact named identity.'));
  }
  return operatorRequest(dataRoot,
    action === 'preview' ? 'operator_preview_owner_removal' : 'operator_remove_owner',
    { clientId, ...details }, options, ['owner_removal_preview', 'owner_removed']);
}

function operatorTerminateDelegate(dataRoot, jobId, options = {}) {
  if (!/^wake_[0-9a-f-]{36}$/.test(jobId || '')) {
    return Promise.reject(new Error('Choose one exact active delegate job.'));
  }
  return operatorRequest(dataRoot, 'operator_terminate_delegate', { jobId }, options,
    ['delegate_termination_requested']);
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
  activeJobChoices,
  delegateJobDetail,
  delegateJobReportLines,
  healthAssessment,
  operatorJobRequest,
  operatorMessageRequest,
  operatorOwnerRepair,
  operatorOwnerRemoval,
  operatorRemovableOwners,
  operatorTerminateDelegate,
  operatorUnusedOwners,
  pendingOwnerLabels,
  messageOwnerChoices,
  ownerChoices,
  previewJobCleanup,
  purgeJobCleanup,
  readJobRecords,
  readMessageRecords,
  relayTopology,
  restartRelay,
  scrollWindow,
  selectableJobs,
  topologyLines
};
