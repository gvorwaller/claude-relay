'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { AccessJwtVerifier, BrowserAuth } = require('./auth');
const {
  createChallenge, envelope, parseEnvelope, validateSnapshot, verifyHandshakeMac
} = require('../monitor-protocol');

const PUBLIC_ROOT = path.join(__dirname, 'public');
const JOB_ID = /^wake_[0-9a-f-]{36}$/;

function configuredSecret(value, filePath, label) {
  if (value) return value;
  if (!filePath) return '';
  const stat = fs.statSync(filePath);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label} file must be mode 0600`);
  const secret = fs.readFileSync(filePath, 'utf8').trim();
  if (!secret) throw new Error(`${label} file is empty`);
  return secret;
}

function securityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.end(body);
}

function readBody(req, maximum = 8192) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > maximum) reject(new Error('Request body is too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function createMonitorWebServer(options = {}) {
  const now = options.now || (() => Date.now());
  const logger = options.logger || console;
  const installationId = options.installationId || process.env.MONITOR_INSTALLATION_ID;
  const agentSecret = options.agentSecret || configuredSecret(
    process.env.MONITOR_AGENT_SECRET,
    process.env.MONITOR_AGENT_SECRET_FILE,
    'Monitor agent secret'
  );
  if (!installationId || !agentSecret) throw new Error('Monitor installation ID and agent secret are required');
  const browserAuth = options.browserAuth || new BrowserAuth({
    password: configuredSecret(
      process.env.MONITOR_WEB_PASSWORD,
      process.env.MONITOR_WEB_PASSWORD_FILE,
      'Monitor web password'
    ),
    csrfSecret: configuredSecret(
      process.env.MONITOR_CSRF_SECRET,
      process.env.MONITOR_CSRF_SECRET_FILE,
      'Monitor CSRF secret'
    ),
    teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN,
    audience: process.env.CF_ACCESS_AUD,
    secureCookies: options.secureCookies === undefined
      ? process.env.MONITOR_SECURE_COOKIES !== '0' : options.secureCookies
  });
  const agentAccess = options.agentAccessVerifier || new AccessJwtVerifier({
    teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN,
    audience: process.env.CF_ACCESS_AGENT_AUD || process.env.CF_ACCESS_AUD
  });
  const state = {
    agent: null,
    snapshot: null,
    lastHeartbeat: null,
    events: [],
    sse: new Set(),
    agentAuthFailures: new Map()
  };
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  function agentState() {
    const age = state.lastHeartbeat === null ? null : Math.max(0, now() - state.lastHeartbeat);
    return {
      state: age === null || age >= 60_000 ? 'offline' : age >= 30_000 ? 'stale' : 'fresh',
      connected: Boolean(state.agent?.authenticated),
      lastHeartbeatAt: state.lastHeartbeat === null ? null : new Date(state.lastHeartbeat).toISOString(),
      heartbeatAgeMs: age
    };
  }

  function publicSnapshot() {
    return state.snapshot ? { ...state.snapshot, agent: agentState() } : { version: 1, snapshot: null, agent: agentState() };
  }

  function agentFailures(remoteAddress) {
    const cutoff = now() - 10 * 60 * 1000;
    const failures = (state.agentAuthFailures.get(remoteAddress) || []).filter(at => at >= cutoff);
    state.agentAuthFailures.set(remoteAddress, failures);
    return failures;
  }

  function recordAgentFailure(remoteAddress) {
    const failures = agentFailures(remoteAddress);
    failures.push(now());
    state.agentAuthFailures.set(remoteAddress, failures);
  }

  function sendSse(client, name, payload) {
    client.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  function broadcast(name, payload) {
    for (const client of state.sse) {
      try { sendSse(client, name, payload); } catch { state.sse.delete(client); }
    }
  }

  async function authenticate(req, res) {
    try { return await browserAuth.authenticate(req); } catch {
      json(res, 401, { error: 'Authentication required' });
      return null;
    }
  }

  async function serveStatic(req, res, pathname) {
    const names = {
      '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js',
      '/styles.css': 'styles.css', '/login': 'login.html', '/login.js': 'login.js'
    };
    const name = names[pathname];
    if (!name) return false;
    if (pathname === '/' || pathname === '/index.html') {
      try { await browserAuth.authenticate(req); } catch {
        res.statusCode = 302;
        res.setHeader('Location', '/login');
        res.end();
        return true;
      }
    }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    text(res, 200, fs.readFileSync(path.join(PUBLIC_ROOT, name), 'utf8'), types[path.extname(name)]);
    return true;
  }

  const server = http.createServer(async (req, res) => {
    securityHeaders(res);
    const url = new URL(req.url, 'http://monitor.invalid');
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true });
      if (req.method === 'POST' && url.pathname === '/login') {
        const body = await readBody(req);
        const contentType = String(req.headers['content-type'] || '');
        const password = contentType.includes('application/json')
          ? JSON.parse(body).password : new URLSearchParams(body).get('password');
        try {
          const session = browserAuth.login(password, req.socket.remoteAddress);
          res.setHeader('Set-Cookie', session.cookie);
          return json(res, 200, { ok: true, csrf: session.csrf });
        } catch (error) {
          return json(res, error.message === 'Too many login attempts' ? 429 : 401, { error: error.message });
        }
      }

      if (req.method === 'GET' && url.pathname === '/login') return serveStatic(req, res, '/login');
      const auth = url.pathname.startsWith('/api/') || req.method === 'POST'
        ? await authenticate(req, res) : null;
      if ((url.pathname.startsWith('/api/') || req.method === 'POST') && !auth) return;

      if (req.method === 'GET' && url.pathname === '/api/v1/session') {
        return json(res, 200, { identity: auth.identity, csrf: browserAuth.csrf(auth) });
      }
      if (req.method === 'POST' && url.pathname === '/logout') {
        if (!browserAuth.verifyCsrf(auth, req.headers['x-csrf-token'])) return json(res, 403, { error: 'Invalid CSRF token' });
        res.setHeader('Set-Cookie', browserAuth.logout(auth));
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/snapshot') {
        return json(res, state.snapshot ? 200 : 503, publicSnapshot());
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/events') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        state.sse.add(res);
        sendSse(res, 'snapshot', publicSnapshot());
        req.on('close', () => state.sse.delete(res));
        return;
      }
      const detailMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)$/);
      if (req.method === 'GET' && detailMatch) {
        const jobId = decodeURIComponent(detailMatch[1]);
        if (!JOB_ID.test(jobId)) return json(res, 400, { error: 'Invalid delegate job' });
        const jobs = [...(state.snapshot?.activeWork || []), ...(state.snapshot?.recentWork || [])];
        const job = jobs.find(item => item.jobId === jobId);
        return job ? json(res, 200, job) : json(res, 404, { error: 'Delegate job is unavailable' });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/v1/actions/')) {
        return json(res, 404, { error: 'Remote actions are disabled in the read-only release' });
      }
      if (await serveStatic(req, res, url.pathname)) return;
      return json(res, 404, { error: 'Not found' });
    } catch {
      return json(res, 400, { error: 'Invalid request' });
    }
  });

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, 'http://monitor.invalid');
    if (url.pathname !== '/api/v1/agent') return socket.destroy();
    const remoteAddress = String(req.socket.remoteAddress || 'unknown');
    if (agentFailures(remoteAddress).length >= 5) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    try {
      if (agentAccess.configured()) await agentAccess.verify(req.headers['cf-access-jwt-assertion']);
    } catch {
      recordAgentFailure(remoteAddress);
      logger.warn?.('relay-monitor-web rejected agent edge authentication');
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  wss.on('connection', ws => {
    const remoteAddress = String(ws._socket?.remoteAddress || 'unknown');
    if (agentFailures(remoteAddress).length >= 5) {
      ws.close(1008, 'Monitor agent authentication rate limit');
      return;
    }
    if (state.agent?.ws?.readyState === 1) {
      ws.close(1008, 'Monitor agent is already connected');
      return;
    }
    const challenge = createChallenge();
    const connection = {
      ws, challenge, challengeExpiresAt: now() + 30_000,
      authenticated: false, expectedSequence: 0
    };
    state.agent = connection;
    ws.send(JSON.stringify(envelope('agent_hello', 0, { installationId, challenge })));
    const handshakeTimeout = setTimeout(() => {
      if (!connection.authenticated) ws.close(1008, 'Monitor agent handshake expired');
    }, 30_000);
    handshakeTimeout.unref();
    ws.on('message', raw => {
      try {
        const message = parseEnvelope(raw, { readOnlyAgent: true });
        if (!connection.authenticated) {
          const keys = Object.keys(message.payload).sort().join(',');
          if (message.type !== 'agent_hello' || message.sequence !== 0 || keys !== 'challenge,installationId,mac'
            || message.payload.installationId !== installationId || message.payload.challenge !== challenge
            || now() > connection.challengeExpiresAt
            || !verifyHandshakeMac(agentSecret, installationId, challenge, message.payload.mac)) {
            throw new Error('Monitor agent authentication failed');
          }
          connection.authenticated = true;
          clearTimeout(handshakeTimeout);
          connection.expectedSequence = 1;
          state.lastHeartbeat = now();
          state.agentAuthFailures.delete(remoteAddress);
          return;
        }
        if (message.sequence !== connection.expectedSequence) throw new Error('Monitor protocol sequence gap');
        connection.expectedSequence += 1;
        if (message.type === 'agent_heartbeat') {
          state.lastHeartbeat = now();
        } else if (message.type === 'snapshot') {
          state.snapshot = validateSnapshot(message.payload);
          state.lastHeartbeat = now();
          broadcast('snapshot', publicSnapshot());
        } else if (message.type === 'event') {
          state.events.push({ sequence: message.sequence, generatedAt: message.generatedAt, payload: message.payload });
          if (state.events.length > 100) state.events.shift();
          broadcast('event', message.payload);
        } else if (message.type !== 'protocol_error') {
          throw new Error('Unsupported read-only agent message');
        }
      } catch (error) {
        if (!connection.authenticated) {
          recordAgentFailure(remoteAddress);
          logger.warn?.('relay-monitor-web rejected agent HMAC authentication');
        }
        try { ws.send(JSON.stringify(envelope('protocol_error', 0, { error: error.message }))); } catch {}
        ws.close(1008, 'Monitor protocol rejected');
      }
    });
    ws.on('close', () => {
      clearTimeout(handshakeTimeout);
      if (state.agent === connection) state.agent = null;
      broadcast('agent', agentState());
    });
  });

  const keepalive = setInterval(() => {
    for (const client of state.sse) client.write(': keepalive\n\n');
    broadcast('agent', agentState());
  }, 15_000);
  keepalive.unref();
  server.on('close', () => clearInterval(keepalive));

  return { server, state, agentState, publicSnapshot };
}

if (require.main === module) {
  const { server } = createMonitorWebServer();
  const host = process.env.MONITOR_WEB_HOST || '127.0.0.1';
  const port = Number(process.env.PORT) || 3006;
  server.listen(port, host, () => process.stdout.write(`relay-monitor-web listening on ${host}:${port}\n`));
}

module.exports = { configuredSecret, createMonitorWebServer, securityHeaders };
