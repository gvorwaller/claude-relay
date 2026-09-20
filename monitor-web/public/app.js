'use strict';

const elements = Object.fromEntries([
  'connection', 'updated', 'health', 'active', 'active-count', 'recent',
  'recent-count', 'identities', 'identity-count', 'detail', 'detail-title',
  'detail-body', 'close-detail', 'stop-confirm', 'close-stop', 'cancel-stop',
  'confirm-stop', 'stop-facts',
  'stop-consequences', 'stop-error'
  , 'admin-section', 'admin', 'admin-notice', 'admin-confirm', 'admin-confirm-title',
  'close-admin-confirm', 'admin-confirm-intro', 'admin-facts', 'admin-consequences',
  'admin-phrase-label', 'admin-phrase', 'admin-error', 'cancel-admin', 'confirm-admin'
].map(id => [id, document.getElementById(id)]));
let csrfToken = '';
let features = { stopDelegate: false, admin: {} };
let pendingPreview = null;
let pendingAdminPreview = null;
let lastPayload = null;
let adminBusy = false;
const adminSelections = new Map();

function age(milliseconds) {
  if (milliseconds === null || milliseconds === undefined) return 'unknown';
  if (milliseconds > 0 && milliseconds < 1000) return '<1s';
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function node(tag, className, value) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (value !== undefined) item.textContent = value;
  return item;
}

function empty(container, message) {
  container.replaceChildren(node('p', 'empty', message));
}

function renderAgent(agent) {
  const visualState = !agent.connected && agent.state === 'fresh' ? 'stale' : agent.state;
  elements.connection.className = `status ${visualState}`;
  elements.connection.textContent = agent.connected
    ? (agent.state === 'fresh' ? 'Connected' : agent.state === 'stale' ? 'Stale' : 'Offline')
    : (agent.state === 'fresh' ? 'Reconnecting' : agent.state === 'stale' ? 'Stale' : 'Offline');
}

function renderHealth(snapshot) {
  const health = snapshot.health;
  elements.health.replaceChildren();
  const headline = node('div', `health-state ${health.state}`);
  headline.append(node('strong', '', health.state === 'healthy' ? 'Healthy' : health.state === 'offline' ? 'Offline' : 'Needs attention'));
  headline.append(node('span', '', `${health.results.filter(result => result.level === 'pass').length} checks passing`));
  elements.health.append(headline);
  const checks = node('ul', 'checks');
  health.results.forEach(result => {
    const item = node('li', result.level);
    item.append(node('span', 'check-dot', ''), node('span', '', result.text));
    checks.append(item);
  });
  elements.health.append(checks);
}

function jobCard(job) {
  const button = node('button', 'job-card');
  button.type = 'button';
  button.dataset.jobId = job.jobId;
  const top = node('div', 'job-top');
  top.append(node('strong', '', job.owner), node('span', `pill ${job.status}`, job.status));
  const active = ['spawned', 'running'].includes(job.status);
  const timing = active
    ? `${job.status === 'spawned' ? 'starting' : 'running'} ${age(job.runAgeMs)}`
    : `ended ${age(job.completedAgeMs)} ago · duration ${age(job.runAgeMs)}`;
  button.append(top, node('p', 'job-meta', `From ${job.requester} · ${timing}`));
  button.append(node('p', 'job-meta', `Current working directory: ${job.currentCwdBasename || 'Unknown'}`));
  if (job.error?.reason) button.append(node('p', 'warning', job.error.reason));
  const activity = job.latestActivity?.label || (active ? 'No sanitized activity yet' : 'No activity captured');
  button.append(node('p', 'activity', `${activity} · ${age(job.lastActivityAgeMs)} ago`));
  const facts = node('div', 'facts');
  facts.append(node('span', job.processAlive ? 'live' : '', job.processAlive ? 'Process alive' : 'Process not alive'));
  if (job.stalled === 'inactive') facts.append(node('span', 'warning', 'Inactive 10m+'));
  if (job.stalled === 'possibly_stuck') facts.append(node('span', 'danger', 'Possibly stuck'));
  button.append(facts);
  button.addEventListener('click', () => showDetail(job.jobId));
  return button;
}

function renderJobs(container, count, jobs, emptyText) {
  count.textContent = String(jobs.length);
  if (!jobs.length) return empty(container, emptyText);
  container.replaceChildren(...jobs.map(jobCard));
}

function renderIdentities(identities) {
  elements['identity-count'].textContent = String(identities.length);
  if (!identities.length) return empty(elements.identities, 'No identities reported.');
  elements.identities.replaceChildren(...identities.map(identity => {
    const card = node('article', 'identity-card');
    const heading = node('div', 'identity-heading');
    heading.append(node('strong', '', identity.identity), node('span', identity.live ? 'live' : 'offline', identity.live ? 'Live' : 'Offline'));
    card.append(heading);
    const parts = [identity.host, identity.source].filter(Boolean);
    card.append(node('p', '', parts.join(' · ') || 'No connection details'));
    card.append(node('p', 'working-directory', `Working directory: ${identity.cwdBasename || 'Unknown'}`));
    if (identity.credentialWarning) card.append(node('p', 'warning', 'Owner credential not confirmed'));
    return card;
  }));
}

const ADMIN_ACTIONS = {
  restartRelay: {
    action: 'restart_relay', route: 'restart-relay', title: 'Restart or repair relay',
    description: 'Restart only the fixed per-user relay service when no delegated work is active.',
    confirm: 'Restart exact relay'
  },
  cleanupActivity: {
    action: 'cleanup_activity', route: 'cleanup-activity', title: 'Clean completed activity',
    description: 'Remove terminal delegate records while preserving every active run.',
    confirm: 'Remove completed activity'
  },
  repairCredential: {
    action: 'repair_owner_credential', route: 'repair-owner-credential', title: 'Repair owner credential',
    description: 'Rotate one pending identity credential locally; no credential leaves the Mac.',
    confirm: 'Repair this identity'
  },
  removeIdentity: {
    action: 'remove_identity', route: 'remove-identity', title: 'Remove identity',
    description: 'Remove one locally eligible identity while preserving messages and completed activity.',
    confirm: 'Remove this identity'
  },
  cleanupMessages: {
    action: 'cleanup_messages', route: 'cleanup-messages', title: 'Clean message history',
    description: 'Irreversibly remove durable messages for one exact identity.',
    confirm: 'Remove message history'
  }
};

function adminTargets(name, payload) {
  const identities = [...new Set([
    ...(payload.identities || []).map(item => item.identity),
    ...(payload.activeWork || []).map(item => item.owner),
    ...(payload.recentWork || []).map(item => item.owner)
  ])].filter(Boolean).sort();
  if (name === 'repairCredential') return (payload.identities || [])
    .filter(item => item.credentialWarning).map(item => ({ label: item.identity, target: { identity: item.identity } }));
  if (name === 'removeIdentity') return identities.map(identity => ({ label: identity, target: { identity } }));
  if (name === 'cleanupActivity') {
    const values = identities.map(identity => ({ label: `${identity} only`, target: { scope: 'owner', identity } }));
    if (features.admin.cleanupActivityAll) values.push({ label: 'All identities', target: { scope: 'all' }, global: true });
    return values;
  }
  if (name === 'cleanupMessages') {
    const values = identities.map(identity => ({ label: `${identity} only`, target: { scope: 'identity', identity } }));
    if (features.admin.cleanupMessagesAll) values.push({ label: 'All message history', target: { scope: 'all' }, global: true });
    return values;
  }
  return [];
}

function adminTargetKey(target) {
  return JSON.stringify(target);
}

function renderAdmin(payload) {
  const available = Object.entries(ADMIN_ACTIONS).filter(([name]) => features.admin?.[name]);
  elements['admin-section'].hidden = available.length === 0;
  if (!available.length) return elements.admin.replaceChildren();
  const cards = available.map(([name, config]) => {
    const card = node('article', `admin-card${name === 'cleanupMessages' ? ' highest-risk' : ''}`);
    card.append(node('h3', '', config.title), node('p', '', config.description));
    if (name === 'restartRelay') {
      const button = node('button', 'secondary-button admin-action', 'Preview restart…');
      button.type = 'button';
      button.disabled = adminBusy;
      button.addEventListener('click', () => previewAdmin(name, {}));
      card.append(button);
      return card;
    }
    const targets = adminTargets(name, payload);
    const targetsByKey = new Map(targets.map(item => [adminTargetKey(item.target), item]));
    const select = node('select', 'admin-select');
    const placeholderText = name === 'cleanupActivity' && features.admin.cleanupActivityAll
      ? 'Choose one identity or all activity'
      : targets.length ? 'Choose one exact target' : 'No eligible target in this snapshot';
    const placeholder = node('option', '', placeholderText);
    placeholder.value = '';
    select.append(placeholder);
    targets.forEach(item => {
      const option = node('option', '', item.label);
      option.value = adminTargetKey(item.target);
      if (item.global) option.className = 'global-option';
      select.append(option);
    });
    const savedSelection = adminSelections.get(name);
    if (savedSelection && targetsByKey.has(savedSelection)) select.value = savedSelection;
    else adminSelections.delete(name);
    const button = node('button', 'secondary-button admin-action', 'Request preview…');
    button.type = 'button';
    button.disabled = adminBusy || !select.value;
    select.disabled = adminBusy || !targets.length;
    select.addEventListener('change', () => {
      if (select.value && targetsByKey.has(select.value)) adminSelections.set(name, select.value);
      else adminSelections.delete(name);
      button.disabled = adminBusy || !select.value;
    });
    button.addEventListener('click', () => {
      const selected = targetsByKey.get(select.value);
      if (selected) previewAdmin(name, selected.target);
    });
    card.append(select, button);
    return card;
  });
  elements.admin.replaceChildren(...cards);
}

function humanize(value) {
  return String(value).replace(/([A-Z])/g, ' $1').replace(/^./, letter => letter.toUpperCase());
}

function displayValue(value) {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return Object.entries(value).map(([key, count]) => `${key}: ${count}`).join(', ') || 'None';
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toLocaleString();
  return String(value);
}

async function previewAdmin(name, target) {
  const config = ADMIN_ACTIONS[name];
  pendingAdminPreview = null;
  elements['admin-confirm-title'].textContent = config.title;
  elements['admin-confirm-intro'].textContent = 'Requesting a fresh, state-bound preview from the local Mac agent…';
  elements['admin-facts'].replaceChildren();
  elements['admin-consequences'].replaceChildren(node('li', '', 'No action occurs until you explicitly confirm.'));
  elements['admin-error'].textContent = '';
  elements['confirm-admin'].textContent = config.confirm;
  elements['confirm-admin'].disabled = true;
  elements['admin-phrase'].value = '';
  elements['admin-phrase'].hidden = true;
  elements['admin-phrase-label'].hidden = true;
  elements['admin-confirm'].showModal();
  elements['cancel-admin'].focus();
  let response;
  let value;
  try {
    response = await actionRequest(`/api/v1/actions/${config.route}/preview`, target);
    value = await response.json();
  } catch {
    elements['admin-error'].textContent = 'The preview request failed. No action was taken.';
    return;
  }
  if (!response.ok) {
    elements['admin-error'].textContent = value.error || 'This action is not currently eligible.';
    return;
  }
  pendingAdminPreview = { name, config, value };
  const facts = [];
  Object.entries(value.summary || {}).forEach(([key, item]) => {
    facts.push(node('dt', '', humanize(key)), node('dd', '', displayValue(item)));
  });
  facts.push(node('dt', '', 'Preview expires'), node('dd', '', new Date(value.expiresAt).toLocaleTimeString()));
  elements['admin-facts'].replaceChildren(...facts);
  elements['admin-consequences'].replaceChildren(...value.consequences.map(item => node('li', '', item)));
  elements['admin-confirm-intro'].textContent = 'Review the local-agent preview. Cancel remains the safe default.';
  const globalMessages = name === 'cleanupMessages' && value.summary?.global === true;
  elements['admin-phrase'].hidden = !globalMessages;
  elements['admin-phrase-label'].hidden = !globalMessages;
  elements['confirm-admin'].disabled = globalMessages;
}

async function confirmAdmin() {
  if (!pendingAdminPreview || adminBusy) return;
  const pending = pendingAdminPreview;
  pendingAdminPreview = null;
  adminBusy = true;
  elements['confirm-admin'].disabled = true;
  elements['confirm-admin'].textContent = 'Working…';
  elements['admin-error'].textContent = '';
  try {
    const response = await actionRequest(`/api/v1/actions/${pending.config.route}/confirm`, {
      confirmationToken: pending.value.confirmationToken
    });
    const value = await response.json();
    if (!response.ok) {
      elements['admin-error'].textContent = value.resultUnknown
        ? 'The result is unknown. The action will not be retried; reconcile from a fresh snapshot.'
        : `${value.error || 'The action was rejected.'} Request a new preview before trying again.`;
      elements['admin-notice'].hidden = false;
      elements['admin-notice'].textContent = elements['admin-error'].textContent;
      return;
    }
    elements['admin-confirm'].close();
    elements['admin-notice'].hidden = false;
    elements['admin-notice'].textContent = `${pending.config.title}: ${humanize(value.outcome)}. Snapshot reconciliation requested.`;
    await loadSnapshot();
  } catch {
    elements['admin-error'].textContent = 'The result is unknown. The action was not retried.';
    elements['admin-notice'].hidden = false;
    elements['admin-notice'].textContent = elements['admin-error'].textContent;
  } finally {
    adminBusy = false;
    elements['confirm-admin'].textContent = pending.config.confirm;
    if (lastPayload) renderAdmin(lastPayload);
  }
}

function render(payload) {
  lastPayload = payload;
  const agent = payload.agent;
  features = payload.features || { stopDelegate: false };
  renderAgent(agent);
  if (!payload.snapshot && !payload.health) {
    elements.updated.textContent = 'Waiting for agent';
    empty(elements.health, 'No relay snapshot is available.');
    empty(elements.active, 'No active snapshot.');
    empty(elements.recent, 'No recent snapshot.');
    empty(elements.identities, 'No identity snapshot.');
    return;
  }
  elements.updated.textContent = `Updated ${new Date(payload.generatedAt).toLocaleTimeString()}`;
  renderHealth(payload);
  renderJobs(elements.active, elements['active-count'], payload.activeWork, 'No active delegated work.');
  renderJobs(elements.recent, elements['recent-count'], payload.recentWork, 'No recent delegated work.');
  renderIdentities(payload.identities);
  renderAdmin(payload);
}

async function showDetail(jobId) {
  const response = await fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}`);
  if (!response.ok) return;
  const job = await response.json();
  elements['detail-title'].textContent = `${job.owner} · ${job.status}`;
  const body = elements['detail-body'];
  body.replaceChildren();
  const fields = [
    ['Job', job.jobId], ['Requester', job.requester], ['Started', job.startedAt || job.requestedAt],
    ['Current working directory', job.currentCwdBasename || 'Unknown'],
    ['Process', job.processAlive ? 'Alive' : 'Not alive']
  ];
  const dl = node('dl', 'detail-facts');
  fields.forEach(([label, value]) => { dl.append(node('dt', '', label), node('dd', '', value)); });
  body.append(dl);
  if (job.error?.reason) body.append(node('h3', '', 'Failure'), node('p', 'warning', job.error.reason));
  if (features.stopDelegate && job.actions?.stopDelegate) {
    const action = node('button', 'danger-button', 'Stop this delegate…');
    action.type = 'button';
    action.addEventListener('click', () => previewStop(job.jobId));
    body.append(action);
  }
  [['Summary', job.summary], ['Changes', job.changes]].forEach(([title, value]) => {
    if (!value) return;
    body.append(node('h3', '', title), node('p', 'report', value));
  });
  if (job.verification?.length) {
    body.append(node('h3', '', 'Verification'));
    const list = node('ul', 'timeline');
    job.verification.forEach(value => list.append(node('li', '', value)));
    body.append(list);
  }
  body.append(node('h3', '', 'Sanitized activity'));
  const timeline = node('ul', 'timeline');
  (job.activity || []).forEach(item => timeline.append(node('li', '', `${new Date(item.at).toLocaleTimeString()} · ${item.label}`)));
  if (!timeline.children.length) timeline.append(node('li', '', 'No activity events captured.'));
  body.append(timeline);
  elements.detail.showModal();
}

async function actionRequest(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify(body)
  });
}

async function previewStop(jobId) {
  elements['stop-error'].textContent = '';
  elements['confirm-stop'].disabled = true;
  elements['stop-facts'].replaceChildren(node('dt', '', 'Job'), node('dd', '', jobId));
  elements['stop-consequences'].replaceChildren(node('li', '', 'Requesting a fresh local preview…'));
  elements['stop-confirm'].showModal();
  let response;
  let value;
  try {
    response = await actionRequest('/api/v1/actions/stop-delegate/preview', { jobId });
    value = await response.json();
  } catch {
    elements['stop-error'].textContent = 'The preview request failed. No action was taken.';
    return;
  }
  if (!response.ok) {
    elements['stop-error'].textContent = value.error || 'The preview is unavailable.';
    return;
  }
  pendingPreview = value;
  elements['stop-facts'].replaceChildren(
    node('dt', '', 'Job'), node('dd', '', value.jobId),
    node('dt', '', 'Owner'), node('dd', '', value.owner),
    node('dt', '', 'Process group'), node('dd', '', value.processAlive ? 'Alive' : 'Not alive'),
    node('dt', '', 'Preview expires'), node('dd', '', new Date(value.expiresAt).toLocaleTimeString())
  );
  elements['stop-consequences'].replaceChildren(...value.consequences.map(item => node('li', '', item)));
  elements['confirm-stop'].disabled = false;
}

async function confirmStop() {
  if (!pendingPreview) return;
  const preview = pendingPreview;
  pendingPreview = null;
  elements['confirm-stop'].disabled = true;
  elements['confirm-stop'].textContent = 'Stopping…';
  elements['stop-error'].textContent = '';
  try {
    const response = await actionRequest('/api/v1/actions/stop-delegate/confirm', {
      jobId: preview.jobId, confirmationToken: preview.confirmationToken
    });
    const value = await response.json();
    if (!response.ok) {
      elements['stop-error'].textContent = value.resultUnknown
        ? 'The result is unknown. Refresh the monitor before taking another action.'
        : `${value.error || 'The action was rejected.'} Request a new preview before trying again.`;
      return;
    }
    elements['stop-confirm'].close();
    elements.detail.close();
    await load();
  } catch {
    elements['stop-error'].textContent = 'The result is unknown. Refresh the monitor before taking another action.';
  } finally {
    elements['confirm-stop'].textContent = 'Stop exact delegate';
  }
}

elements['close-detail'].addEventListener('click', () => elements.detail.close());
elements['close-stop'].addEventListener('click', () => elements['stop-confirm'].close());
elements['cancel-stop'].addEventListener('click', () => elements['stop-confirm'].close());
elements['confirm-stop'].addEventListener('click', confirmStop);
elements['stop-confirm'].addEventListener('close', () => { pendingPreview = null; });
elements['close-admin-confirm'].addEventListener('click', () => elements['admin-confirm'].close());
elements['cancel-admin'].addEventListener('click', () => elements['admin-confirm'].close());
elements['confirm-admin'].addEventListener('click', confirmAdmin);
elements['admin-confirm'].addEventListener('close', () => { pendingAdminPreview = null; elements['admin-phrase'].value = ''; });
elements['admin-confirm'].addEventListener('cancel', event => {
  event.preventDefault();
  elements['admin-confirm'].close();
});
elements['admin-confirm'].addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault();
    elements['admin-confirm'].close();
  }
});
elements['admin-phrase'].addEventListener('input', () => {
  elements['confirm-admin'].disabled = elements['admin-phrase'].value !== 'DELETE ALL MESSAGE HISTORY';
});

async function loadSnapshot() {
  const response = await fetch('/api/v1/snapshot');
  if (response.status === 401) return window.location.replace('/login');
  render(await response.json());
}

async function load() {
  const session = await fetch('/api/v1/session');
  if (session.status === 401) return window.location.replace('/login');
  csrfToken = (await session.json()).csrf;
  await loadSnapshot();
}

load();
const events = new EventSource('/api/v1/events');
events.addEventListener('snapshot', event => render(JSON.parse(event.data)));
events.addEventListener('agent', event => {
  const agent = JSON.parse(event.data);
  renderAgent(agent);
  if (!agent.connected || agent.state !== 'fresh') {
    features.stopDelegate = false;
    features.admin = {};
    if (lastPayload) renderAdmin(lastPayload);
  }
});
