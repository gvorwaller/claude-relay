'use strict';

const elements = Object.fromEntries([
  'connection', 'updated', 'health', 'active', 'active-count', 'recent',
  'recent-count', 'identities', 'identity-count', 'detail', 'detail-title',
  'detail-body', 'close-detail'
].map(id => [id, document.getElementById(id)]));

function age(milliseconds) {
  if (milliseconds === null || milliseconds === undefined) return 'unknown';
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
  button.append(top, node('p', 'job-meta', `From ${job.requester} · running ${age(job.runAgeMs)}`));
  const activity = job.latestActivity?.label || 'No sanitized activity yet';
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
    const parts = [identity.host, identity.cwdBasename, identity.source].filter(Boolean);
    card.append(node('p', '', parts.join(' · ') || 'No connection details'));
    if (identity.credentialWarning) card.append(node('p', 'warning', 'Owner credential not confirmed'));
    return card;
  }));
}

function render(payload) {
  const agent = payload.agent;
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
    ['Process', job.processAlive ? 'Alive' : 'Not alive']
  ];
  const dl = node('dl', 'detail-facts');
  fields.forEach(([label, value]) => { dl.append(node('dt', '', label), node('dd', '', value)); });
  body.append(dl);
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

elements['close-detail'].addEventListener('click', () => elements.detail.close());

async function load() {
  const response = await fetch('/api/v1/snapshot');
  if (response.status === 401) return window.location.replace('/login');
  render(await response.json());
}

load();
const events = new EventSource('/api/v1/events');
events.addEventListener('snapshot', event => render(JSON.parse(event.data)));
events.addEventListener('agent', event => {
  renderAgent(JSON.parse(event.data));
});
