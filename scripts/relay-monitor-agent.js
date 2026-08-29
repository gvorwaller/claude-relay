#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { buildMonitorSnapshot } = require('../monitor-model');
const { envelope, handshakeMac, parseEnvelope } = require('../monitor-protocol');

function readPrivateFile(filePath, label) {
  if (!filePath) throw new Error(`${label} file is required`);
  const stat = fs.statSync(filePath);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label} file must not be accessible by group or other users`);
  const value = fs.readFileSync(filePath, 'utf8').trim();
  if (!value) throw new Error(`${label} file is empty`);
  return value;
}

function createMonitorAgent(options = {}) {
  const url = options.url || process.env.MONITOR_WEB_URL;
  const installationId = options.installationId || process.env.MONITOR_INSTALLATION_ID;
  const secret = options.secret || readPrivateFile(
    options.secretFile || process.env.MONITOR_AGENT_SECRET_FILE,
    'Monitor agent secret'
  );
  const dataRoot = options.dataRoot || process.env.RELAY_DATA_DIR || path.join(__dirname, '..', 'data');
  const WebSocketClient = options.WebSocket || WebSocket;
  const buildSnapshot = options.buildSnapshot || buildMonitorSnapshot;
  const logger = options.logger || console;
  const snapshotIntervalMs = options.snapshotIntervalMs || 5_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs || 10_000;
  const allowInsecure = options.allowInsecure || process.env.MONITOR_ALLOW_INSECURE === '1';
  if (!url || !installationId) throw new Error('Monitor web URL and installation ID are required');
  const parsed = new URL(url);
  if (parsed.protocol !== 'wss:' && !(allowInsecure && parsed.protocol === 'ws:')) {
    throw new Error('Monitor agent requires a wss URL');
  }
  const headers = { ...(options.headers || {}) };
  const accessClientId = options.accessClientId || process.env.CF_ACCESS_CLIENT_ID;
  const accessClientSecret = options.accessClientSecret || (process.env.CF_ACCESS_CLIENT_SECRET_FILE
    ? readPrivateFile(process.env.CF_ACCESS_CLIENT_SECRET_FILE, 'Cloudflare Access client secret') : null);
  if (accessClientId || accessClientSecret) {
    if (!accessClientId || !accessClientSecret) throw new Error('Both Cloudflare Access service-token values are required');
    headers['CF-Access-Client-Id'] = accessClientId;
    headers['CF-Access-Client-Secret'] = accessClientSecret;
  }

  const state = {
    socket: null, stopped: false, connected: false, authenticated: false,
    sequence: 0, retryMs: 1_000, reconnectTimer: null, snapshotTimer: null,
    heartbeatTimer: null, publishing: false
  };

  function clearConnectionTimers() {
    clearInterval(state.snapshotTimer);
    clearInterval(state.heartbeatTimer);
    state.snapshotTimer = null;
    state.heartbeatTimer = null;
  }

  function send(type, payload) {
    if (!state.socket || state.socket.readyState !== WebSocketClient.OPEN) return false;
    state.socket.send(JSON.stringify(envelope(type, state.sequence, payload)));
    state.sequence += 1;
    return true;
  }

  async function publishSnapshot() {
    if (!state.authenticated || state.publishing) return;
    state.publishing = true;
    try {
      const snapshot = await buildSnapshot(dataRoot);
      send('snapshot', snapshot);
    } catch {
      send('event', { category: 'snapshot_unavailable' });
    } finally {
      state.publishing = false;
    }
  }

  function beginPublishing() {
    if (state.authenticated) return;
    state.authenticated = true;
    state.sequence = 1;
    state.retryMs = 1_000;
    publishSnapshot();
    state.snapshotTimer = setInterval(publishSnapshot, snapshotIntervalMs);
    state.heartbeatTimer = setInterval(() => send('agent_heartbeat', {}), heartbeatIntervalMs);
  }

  function scheduleReconnect() {
    if (state.stopped || state.reconnectTimer) return;
    const delay = state.retryMs + Math.floor(Math.random() * Math.min(1_000, state.retryMs / 4));
    state.retryMs = Math.min(30_000, state.retryMs * 2);
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      connect();
    }, delay);
    state.reconnectTimer.unref?.();
  }

  function connect() {
    if (state.stopped) return;
    clearConnectionTimers();
    state.authenticated = false;
    state.sequence = 0;
    const socket = new WebSocketClient(url, { headers, maxPayload: 1024 * 1024 });
    state.socket = socket;
    socket.on('open', () => {
      state.connected = true;
      logger.info?.('relay-monitor-agent connected');
    });
    socket.on('message', raw => {
      try {
        const message = parseEnvelope(raw, { readOnlyAgent: true });
        if (message.type !== 'agent_hello' || message.sequence !== 0 || state.authenticated) return;
        const { challenge, installationId: expectedInstallation } = message.payload;
        if (expectedInstallation !== installationId || typeof challenge !== 'string') throw new Error('Monitor server identity mismatch');
        socket.send(JSON.stringify(envelope('agent_hello', 0, {
          installationId,
          challenge,
          mac: handshakeMac(secret, installationId, challenge)
        })));
        beginPublishing();
      } catch {
        socket.close(1008, 'Monitor handshake rejected');
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (state.socket === socket) state.socket = null;
      state.connected = false;
      state.authenticated = false;
      clearConnectionTimers();
      logger.warn?.('relay-monitor-agent disconnected');
      scheduleReconnect();
    });
  }

  function start() {
    state.stopped = false;
    connect();
  }

  function stop() {
    state.stopped = true;
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    clearConnectionTimers();
    try { state.socket?.close(1000, 'Monitor agent stopping'); } catch {}
  }

  return { start, stop, state, publishSnapshot };
}

if (require.main === module) {
  const agent = createMonitorAgent();
  agent.start();
  process.on('SIGTERM', () => { agent.stop(); process.exit(0); });
  process.on('SIGINT', () => { agent.stop(); process.exit(0); });
}

module.exports = { createMonitorAgent, readPrivateFile };
