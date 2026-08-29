'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMonitorWebServer } = require('../monitor-web/server');
const { envelope, handshakeMac, parseEnvelope } = require('../monitor-protocol');
const { createMonitorAgent } = require('../scripts/relay-monitor-agent');
const { configuredSecret } = require('../monitor-web/server');

const PASSWORD = 'this-is-a-high-entropy-test-password-value';
const AGENT_SECRET = 'this-is-a-separate-agent-secret-value';

function snapshot(owner = 'CC1') {
  return {
    version: 1,
    generatedAt: '2026-08-29T16:00:00.000Z',
    health: { state: 'healthy', ok: true, results: [], metrics: null, alerts: [] },
    activeWork: [{
      jobId: 'wake_10000000-0000-4000-8000-000000000001', owner, requester: 'CODEX',
      status: 'running', requestedAt: '2026-08-29T15:55:00.000Z', startedAt: null,
      completedAt: null, requestedAgeMs: 300000, runAgeMs: 300000,
      lastActivityAt: '2026-08-29T15:59:00.000Z', lastActivityAgeMs: 60000,
      latestActivity: { type: 'waiting', label: 'Waiting' }, processAlive: true,
      stalled: null, actions: { stopDelegate: true }, outbound: [], activity: [], summary: null, changes: null,
      verification: [], error: null
    }],
    recentWork: [], identities: [], topologyError: null
  };
}

async function startWeb(t, options = {}) {
  const app = createMonitorWebServer({
    installationId: 'home-relay', agentSecret: AGENT_SECRET,
    secureCookies: false, logger: { warn() {}, info() {} }, ...options,
    browserAuth: options.browserAuth
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    try { app.state.agent?.ws?.terminate(); } catch {}
    await new Promise(resolve => app.server.close(resolve));
  });
  return { ...app, base, wsUrl: `ws://127.0.0.1:${address.port}/api/v1/agent` };
}

function passwordAuth() {
  const { BrowserAuth } = require('../monitor-web/auth');
  return new BrowserAuth({ password: PASSWORD, secureCookies: false });
}

async function login(base) {
  const response = await fetch(`${base}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD })
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

async function sessionCsrf(base, cookie) {
  const response = await fetch(`${base}/api/v1/session`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  return (await response.json()).csrf;
}

function connectAgent(url, secret = AGENT_SECRET) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('error', reject);
    ws.once('message', raw => {
      const hello = parseEnvelope(raw);
      ws.send(JSON.stringify(envelope('agent_hello', 0, {
        installationId: 'home-relay', challenge: hello.payload.challenge,
        mac: handshakeMac(secret, 'home-relay', hello.payload.challenge)
      })));
      resolve({ ws, hello });
    });
  });
}

async function waitFor(check, timeout = 2000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

test('health is public but snapshots require a browser session and no-store headers', async t => {
  const app = await startWeb(t, { browserAuth: passwordAuth() });
  const health = await fetch(`${app.base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal(health.headers.get('x-frame-options'), 'DENY');
  const denied = await fetch(`${app.base}/api/v1/snapshot`);
  assert.equal(denied.status, 401);
  const cookie = await login(app.base);
  const allowed = await fetch(`${app.base}/api/v1/snapshot`, { headers: { Cookie: cookie } });
  assert.equal(allowed.status, 503);
  assert.equal((await allowed.json()).agent.state, 'offline');
});

test('web secrets can be loaded only from private non-empty files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-monitor-web-secret-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'secret');
  fs.writeFileSync(file, 'private-value\n', { mode: 0o600 });
  assert.equal(configuredSecret('', file, 'Test secret'), 'private-value');
  fs.chmodSync(file, 0o644);
  assert.throws(() => configuredSecret('', file, 'Test secret'), /mode 0600/);
});

test('browser session exposes CSRF and logout rejects missing or wrong tokens', async t => {
  const app = await startWeb(t, { browserAuth: passwordAuth() });
  const cookie = await login(app.base);
  const session = await fetch(`${app.base}/api/v1/session`, { headers: { Cookie: cookie } });
  const { csrf } = await session.json();
  assert.ok(csrf);
  const rejected = await fetch(`${app.base}/logout`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': 'wrong' } });
  assert.equal(rejected.status, 403);
  const logout = await fetch(`${app.base}/logout`, { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf } });
  assert.equal(logout.status, 200);
  const after = await fetch(`${app.base}/api/v1/session`, { headers: { Cookie: cookie } });
  assert.equal(after.status, 401);
});

test('agent freshness changes to stale at 30 seconds and offline at 60 seconds', async t => {
  let now = Date.parse('2026-08-29T16:00:00.000Z');
  const app = await startWeb(t, { browserAuth: passwordAuth(), now: () => now });
  app.state.lastHeartbeat = now;
  assert.equal(app.agentState().state, 'fresh');
  now += 30_000;
  assert.equal(app.agentState().state, 'stale');
  now += 30_000;
  assert.equal(app.agentState().state, 'offline');
});

test('authenticated SSE starts with a complete replaceable snapshot and disables buffering', async t => {
  const app = await startWeb(t, { browserAuth: passwordAuth() });
  const cookie = await login(app.base);
  const controller = new AbortController();
  const response = await fetch(`${app.base}/api/v1/events`, {
    headers: { Cookie: cookie }, signal: controller.signal
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const first = await response.body.getReader().read();
  controller.abort();
  const body = Buffer.from(first.value).toString('utf8');
  assert.match(body, /^event: snapshot\ndata: /);
  assert.match(body, /"agent":\{"state":"offline"/);
});

test('authenticated agent publishes a snapshot and a sequence gap forces reconnect replacement', async t => {
  const app = await startWeb(t, { browserAuth: passwordAuth() });
  const cookie = await login(app.base);
  const first = await connectAgent(app.wsUrl);
  first.ws.send(JSON.stringify(envelope('snapshot', 1, snapshot('CC1'))));
  await waitFor(() => app.state.snapshot?.activeWork?.[0]?.owner === 'CC1');
  const response = await fetch(`${app.base}/api/v1/snapshot`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).activeWork[0].owner, 'CC1');

  const closed = new Promise(resolve => first.ws.once('close', resolve));
  first.ws.send(JSON.stringify(envelope('agent_heartbeat', 3, {})));
  await closed;
  const second = await connectAgent(app.wsUrl);
  second.ws.send(JSON.stringify(envelope('snapshot', 1, snapshot('CC2'))));
  await waitFor(() => app.state.snapshot?.activeWork?.[0]?.owner === 'CC2');
  assert.equal(app.state.snapshot.activeWork.length, 1);
  second.ws.close();
});

test('captured handshake cannot authenticate against a fresh challenge', async t => {
  const app = await startWeb(t, { browserAuth: passwordAuth() });
  const first = await connectAgent(app.wsUrl);
  const captured = {
    installationId: 'home-relay', challenge: first.hello.payload.challenge,
    mac: handshakeMac(AGENT_SECRET, 'home-relay', first.hello.payload.challenge)
  };
  first.ws.close();
  await new Promise(resolve => first.ws.once('close', resolve));

  const replay = new WebSocket(app.wsUrl);
  const closed = new Promise(resolve => replay.once('close', (code) => resolve(code)));
  const challenged = new Promise(resolve => replay.once('message', resolve));
  await new Promise((resolve, reject) => replay.once('open', resolve).once('error', reject));
  await challenged;
  replay.send(JSON.stringify(envelope('agent_hello', 0, captured)));
  assert.equal(await closed, 1008);
});

test('repeated agent authentication failures are rate-limited without logging credentials', async t => {
  const warnings = [];
  const app = await startWeb(t, {
    browserAuth: passwordAuth(), logger: { warn(value) { warnings.push(value); }, info() {} }
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const connection = await connectAgent(app.wsUrl, 'wrong-agent-secret-with-at-least-32-bytes');
    const code = await new Promise(resolve => connection.ws.once('close', resolve));
    assert.equal(code, 1008);
  }
  const limited = new WebSocket(app.wsUrl);
  const error = await new Promise(resolve => limited.once('error', resolve));
  assert.match(error.message, /429/);
  assert.equal(warnings.length, 5);
  assert.doesNotMatch(warnings.join(' '), /wrong-agent-secret|agent-secret-with/);
});

test('real outbound agent completes handshake and publishes the full replacement snapshot', async t => {
  const app = await startWeb(t, { browserAuth: passwordAuth() });
  const agent = createMonitorAgent({
    url: app.wsUrl, installationId: 'home-relay', secret: AGENT_SECRET,
    allowInsecure: true, snapshotIntervalMs: 60_000, heartbeatIntervalMs: 60_000,
    buildSnapshot: async () => snapshot('AGY'),
    logger: { info() {}, warn() {} }
  });
  t.after(() => agent.stop());
  agent.start();
  await waitFor(() => app.state.snapshot?.activeWork?.[0]?.owner === 'AGY');
  assert.equal(app.state.agent.authenticated, true);
});

test('stop endpoints are disabled by default and require CSRF when enabled', async t => {
  const disabled = await startWeb(t, { browserAuth: passwordAuth() });
  const disabledCookie = await login(disabled.base);
  const response = await fetch(`${disabled.base}/api/v1/actions/stop-delegate/preview`, {
    method: 'POST', headers: { Cookie: disabledCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: 'wake_10000000-0000-4000-8000-000000000001' })
  });
  assert.equal(response.status, 404);

  const enabled = await startWeb(t, { browserAuth: passwordAuth(), enableStopDelegate: true });
  enabled.state.snapshot = snapshot();
  const cookie = await login(enabled.base);
  const rejected = await fetch(`${enabled.base}/api/v1/actions/stop-delegate/preview`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: enabled.state.snapshot.activeWork[0].jobId })
  });
  assert.equal(rejected.status, 403);
});

test('browser preview and confirmation round-trip through the agent exactly once', async t => {
  const app = await startWeb(t, { browserAuth: passwordAuth(), enableStopDelegate: true });
  const jobId = 'wake_10000000-0000-4000-8000-000000000001';
  const confirmationToken = 'Z'.repeat(43);
  let consumed = false;
  let confirmations = 0;
  const stopController = {
    preview(exactJobId) {
      assert.equal(exactJobId, jobId);
      return {
        action: 'stop_delegate', jobId, owner: 'CC1', processAlive: true,
        consequences: [
          'The exact active delegate process group will be terminated.',
          'The delegate job will become interrupted.',
          'Its audit record and durable relay mail will be preserved.'
        ],
        confirmationToken, expiresAt: new Date(Date.now() + 60_000).toISOString()
      };
    },
    async confirm(exactJobId, token) {
      if (exactJobId !== jobId || token !== confirmationToken || consumed) {
        throw new Error('Confirmation is invalid or already used');
      }
      consumed = true;
      confirmations += 1;
      return {
        action: 'stop_delegate', jobId, owner: 'CC1', status: 'interrupted',
        signaled: true, completedAt: new Date().toISOString()
      };
    }
  };
  const agent = createMonitorAgent({
    url: app.wsUrl, installationId: 'home-relay', secret: AGENT_SECRET,
    allowInsecure: true, enableStopDelegate: true, stopController,
    snapshotIntervalMs: 60_000, heartbeatIntervalMs: 60_000,
    buildSnapshot: async () => snapshot(), logger: { info() {}, warn() {} }
  });
  t.after(() => agent.stop());
  agent.start();
  await waitFor(() => app.state.snapshot?.activeWork?.[0]?.jobId === jobId);
  const cookie = await login(app.base);
  const csrf = await sessionCsrf(app.base, cookie);
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };

  const previewResponse = await fetch(`${app.base}/api/v1/actions/stop-delegate/preview`, {
    method: 'POST', headers, body: JSON.stringify({ jobId })
  });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.confirmationToken, confirmationToken);
  assert.doesNotMatch(JSON.stringify(preview), /pid|signal|command/i);

  const confirm = () => fetch(`${app.base}/api/v1/actions/stop-delegate/confirm`, {
    method: 'POST', headers,
    body: JSON.stringify({ jobId, confirmationToken: preview.confirmationToken })
  });
  const first = await confirm();
  assert.equal(first.status, 200);
  assert.equal((await first.json()).status, 'interrupted');
  const replay = await confirm();
  assert.equal(replay.status, 409);
  assert.equal(confirmations, 1);
  assert.equal(app.state.actionAudit.length, 2);
  assert.deepEqual(app.state.actionAudit.map(item => item.outcome), ['interrupted', 'rejected']);
});

test('agent disconnect after confirmation reports unknown and never retries the mutation', async t => {
  const app = await startWeb(t, { browserAuth: passwordAuth(), enableStopDelegate: true });
  const jobId = 'wake_10000000-0000-4000-8000-000000000001';
  const confirmationToken = 'Y'.repeat(43);
  let confirmations = 0;
  const stopController = {
    preview() {
      return {
        action: 'stop_delegate', jobId, owner: 'CC1', processAlive: true,
        consequences: ['Exact process group stops.', 'Job becomes interrupted.', 'Durable mail remains.'],
        confirmationToken, expiresAt: new Date(Date.now() + 60_000).toISOString()
      };
    },
    confirm() {
      confirmations += 1;
      return new Promise(() => {});
    }
  };
  const agent = createMonitorAgent({
    url: app.wsUrl, installationId: 'home-relay', secret: AGENT_SECRET,
    allowInsecure: true, enableStopDelegate: true, stopController,
    snapshotIntervalMs: 60_000, heartbeatIntervalMs: 60_000,
    buildSnapshot: async () => snapshot(), logger: { info() {}, warn() {} }
  });
  t.after(() => agent.stop());
  agent.start();
  await waitFor(() => app.state.snapshot?.activeWork?.[0]?.jobId === jobId);
  const cookie = await login(app.base);
  const csrf = await sessionCsrf(app.base, cookie);
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
  const previewResponse = await fetch(`${app.base}/api/v1/actions/stop-delegate/preview`, {
    method: 'POST', headers, body: JSON.stringify({ jobId })
  });
  const preview = await previewResponse.json();
  const pending = fetch(`${app.base}/api/v1/actions/stop-delegate/confirm`, {
    method: 'POST', headers,
    body: JSON.stringify({ jobId, confirmationToken: preview.confirmationToken })
  });
  await waitFor(() => confirmations === 1);
  app.state.agent.ws.terminate();
  const response = await pending;
  assert.equal(response.status, 504);
  assert.equal((await response.json()).resultUnknown, true);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(confirmations, 1);
});
