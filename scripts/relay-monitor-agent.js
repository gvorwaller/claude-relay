#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { buildMonitorSnapshot, createStopDelegateController } = require('../monitor-model');
const { actionGates, createAdminController, enabledActions } = require('../monitor-admin');
const {
  envelope, handshakeMac, parseEnvelope, validateAgentCommand
} = require('../monitor-protocol');

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
  const enableStopDelegate = options.enableStopDelegate === undefined
    ? process.env.MONITOR_STOP_DELEGATE_ENABLED === '1' : options.enableStopDelegate;
  const adminGates = options.adminGates || actionGates(options.env || process.env);
  const adminActions = enabledActions(adminGates);
  const enableCommands = enableStopDelegate || adminActions.length > 0;
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
    heartbeatTimer: null, publishing: false, expectedServerSequence: 0
  };
  const stopController = options.stopController || createStopDelegateController(dataRoot, options.stopControllerOptions);
  const adminController = options.adminController || createAdminController(dataRoot, {
    gates: adminGates, installationId, ...(options.adminControllerOptions || {})
  });

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
    state.expectedServerSequence = 1;
    state.retryMs = 1_000;
    adminController.setConnectionGeneration(`${installationId}:${Date.now()}:${Math.random()}`);
    send('agent_capabilities', { revision: 1, actions: adminActions });
    publishSnapshot();
    state.snapshotTimer = setInterval(publishSnapshot, snapshotIntervalMs);
    state.heartbeatTimer = setInterval(() => send('agent_heartbeat', {}), heartbeatIntervalMs);
  }

  function commandError(error) {
    const value = String(error?.message || 'Action failed');
    if (/no longer active/i.test(value)) return 'That delegate is no longer active';
    if (/state changed/i.test(value)) return 'Delegate state changed; preview it again before confirming';
    if (/expired/i.test(value)) return 'Confirmation has expired';
    if (/invalid|already used/i.test(value)) return 'Confirmation is invalid or already used';
    const bounded = new Set([
      'action_disabled', 'scope_disabled', 'invalid_target', 'identity_not_pending',
      'identity_not_removable', 'active_work', 'job_store_unreadable', 'action_busy',
      'confirmation_invalid', 'confirmation_expired', 'state_changed', 'restart_failed'
    ]);
    if (bounded.has(value)) return value;
    return 'The local relay could not complete the requested action';
  }

  async function handleCommand(message) {
    const payload = validateAgentCommand(message.type, message.payload);
    try {
      if (payload.action !== 'stop_delegate' && message.type === 'preview_request') {
        const preview = await adminController.preview(payload.action, payload.target);
        send('preview_result', { requestId: payload.requestId, ok: true, preview });
      } else if (payload.action !== 'stop_delegate') {
        const result = await adminController.confirm(payload.action, payload.confirmationToken);
        send('action_result', { requestId: payload.requestId, ok: true, result });
        await publishSnapshot();
      } else if (message.type === 'preview_request') {
        const preview = stopController.preview(payload.jobId);
        send('preview_result', { requestId: payload.requestId, ok: true, preview });
      } else {
        const result = await stopController.confirm(payload.jobId, payload.confirmationToken);
        send('action_result', { requestId: payload.requestId, ok: true, result });
        await publishSnapshot();
      }
    } catch (error) {
      send(message.type === 'preview_request' ? 'preview_result' : 'action_result', {
        requestId: payload.requestId, ok: false, error: commandError(error)
      });
      if (message.type === 'confirm_request') await publishSnapshot();
    }
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
    state.expectedServerSequence = 0;
    const socket = new WebSocketClient(url, { headers, maxPayload: 1024 * 1024 });
    state.socket = socket;
    socket.on('open', () => {
      state.connected = true;
      logger.info?.('relay-monitor-agent connected');
    });
    socket.on('message', raw => {
      try {
        const message = parseEnvelope(raw, { readOnlyAgent: !enableCommands });
        if (!state.authenticated) {
          if (message.type !== 'agent_hello' || message.sequence !== 0) throw new Error('Monitor handshake rejected');
          const { challenge, installationId: expectedInstallation } = message.payload;
          if (expectedInstallation !== installationId || typeof challenge !== 'string') throw new Error('Monitor server identity mismatch');
          socket.send(JSON.stringify(envelope('agent_hello', 0, {
            installationId,
            challenge,
            mac: handshakeMac(secret, installationId, challenge)
          })));
          beginPublishing();
          return;
        }
        if (!enableCommands || message.sequence !== state.expectedServerSequence) {
          throw new Error('Monitor command protocol rejected');
        }
        state.expectedServerSequence += 1;
        handleCommand(message).catch(() => socket.close(1008, 'Monitor command failed'));
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
