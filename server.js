#!/usr/bin/env node
/**
 * Claude Relay Server
 *
 * WebSocket relay that enables real-time communication between
 * Claude Code instances on M1 and M2.
 *
 * Usage: node server.js [port]
 * Default port: 9999
 */

const { WebSocketServer } = require('ws');
const { MessageStore } = require('./message-store');
const { OperationalLogger } = require('./operational-logger');

const PORT = parseInt(process.argv[2] || process.env.RELAY_PORT || '9999', 10);
const MESSAGE_RETENTION_DAYS = parseInt(process.env.RELAY_MESSAGE_RETENTION_DAYS || '7', 10);
const MESSAGE_MAX_DISK_MB = parseInt(process.env.RELAY_MESSAGE_MAX_DISK_MB || '100', 10);
const CACHE_MAX_MESSAGES = parseInt(process.env.RELAY_CACHE_MAX_MESSAGES || '500', 10);
const CACHE_MAX_MB = parseInt(process.env.RELAY_CACHE_MAX_MB || '10', 10);
const ADMIN_CLIENT_IDS = new Set(
  (process.env.RELAY_ADMIN_CLIENT_IDS || '').split(',').map(value => value.trim()).filter(Boolean)
);

const messageStore = new MessageStore({
  dataDir: process.env.RELAY_MESSAGE_DIR,
  retentionDays: MESSAGE_RETENTION_DAYS,
  maxDiskBytes: MESSAGE_MAX_DISK_MB * 1024 * 1024,
  maxCacheMessages: CACHE_MAX_MESSAGES,
  maxCacheBytes: CACHE_MAX_MB * 1024 * 1024
});
messageStore.initialize();
const logger = new OperationalLogger({
  logDir: process.env.RELAY_LOG_DIR,
  retentionDays: parseInt(process.env.RELAY_LOG_RETENTION_DAYS || '7', 10),
  maxTotalBytes: parseInt(process.env.RELAY_LOG_MAX_TOTAL_MB || '50', 10) * 1024 * 1024,
  maxFileBytes: parseInt(process.env.RELAY_LOG_MAX_FILE_MB || '10', 10) * 1024 * 1024
});

// Connected clients: Map<clientId, WebSocket>
const clients = new Map();
// Per-client metadata reported at register time: Map<clientId, meta>
// Lets any peer discover the full cluster (cwd/host/started) via get_sessions,
// not just the local machine's registry.json file.
const clientMeta = new Map();
const duplicateLogTimes = new Map();
// Content-free background watchers. Map<targetClientId, Set<WebSocket>>.
// Watchers receive only an existence ping; they never inherit target history
// visibility or message content.
const watchers = new Map();

const wss = new WebSocketServer({ host: '0.0.0.0', port: PORT });

logger.info('server_starting', { port: PORT });

wss.on('listening', () => {
  logger.info('server_listening', { port: PORT, host: '0.0.0.0' });
});

wss.on('connection', (ws, req) => {
  let clientId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  logger.info('connection_opened', { remoteAddress: req.socket.remoteAddress });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'register':
          // Client identifies itself (M1, M2, etc.)
          const requestedClientId = msg.clientId || 'unknown';
          const existingClient = clients.get(requestedClientId);
          if (existingClient && existingClient !== ws && existingClient.readyState === 1) {
            // Newest-wins takeover (2026-07-17). Reject-duplicate looked safe but
            // locked out every legitimate reconnect: a stale-but-alive holder
            // (an MCP bridge whose Claude Code session was replaced, a Codex CLI
            // that respawned) passes the ws heartbeat forever, so the REAL
            // client could never reclaim its ID (CC2 and CODEX2 both hit this).
            // The newest registration is the one a human is actually using.
            // The displaced socket is told why and terminated, so its owner
            // fails loudly instead of consuming messages nobody reads.
            const now = Date.now();
            if (now - (duplicateLogTimes.get(requestedClientId) || 0) >= 60000) {
              logger.warn('duplicate_client_takeover', {
                clientId: requestedClientId,
                displacedRemoteAddress: existingClient._socket?.remoteAddress || null,
                newRemoteAddress: req.socket.remoteAddress
              });
              duplicateLogTimes.set(requestedClientId, now);
            }
            try {
              existingClient.send(JSON.stringify({
                type: 'error',
                message: `Client ID ${requestedClientId} was re-registered by a newer connection; this connection is being closed`
              }));
            } catch (_) { /* displaced socket may already be unwritable */ }
            existingClient.displacedByTakeover = true;
            existingClient.terminate();
          }

          clientId = requestedClientId;
          ws.clientId = clientId;
          clients.set(clientId, ws);
          // Remember whatever metadata the client reported (cwd, host, started,
          // pid, source). Older clients omit msg.meta — store an empty object so
          // they still appear (ID-only) in the cluster session list.
          clientMeta.set(clientId, {
            ...(msg.meta && typeof msg.meta === 'object' ? msg.meta : {}),
            remoteAddress: req.socket.remoteAddress,
            connectedAt: new Date().toISOString()
          });
          logger.info('client_registered', { clientId, remoteAddress: req.socket.remoteAddress });

          // Send registration confirmation
          ws.send(JSON.stringify({
            type: 'registered',
            clientId,
            peers: Array.from(clients.keys()).filter(id => id !== clientId)
          }));

          // Broadcast peer update to others
          broadcast({
            type: 'peer_joined',
            clientId,
            peers: Array.from(clients.keys())
          }, clientId);
          break;

        case 'message':
          if (!clientId) {
            ws.send(JSON.stringify({ type: 'error', message: 'Register before sending messages' }));
            return;
          }
          if (typeof msg.content !== 'string') {
            ws.send(JSON.stringify({ type: 'error', message: 'Message content must be a string' }));
            return;
          }
          const to = msg.to || 'all';
          const target = to === 'all' ? null : clients.get(to);
          const delivered = to === 'all'
            ? Array.from(clients.entries()).some(([id, peer]) => id !== clientId && peer.readyState === 1)
            : Boolean(target && target.readyState === 1);
          const envelope = messageStore.append({
            type: 'message',
            from: clientId,
            to,
            content: msg.content,
            delivered
          });

          if (msg.to && msg.to !== 'all') {
            // Direct message to specific client
            if (target && target.readyState === 1) {
              target.send(JSON.stringify(envelope));
            } else {
              ws.send(JSON.stringify({
                type: 'error',
                message: `Client ${msg.to} not connected`
              }));
            }
          } else {
            // Broadcast to all except sender
            broadcast(envelope, clientId);
          }
          logger.info('message_recorded', {
            messageId: envelope.id,
            from: clientId,
            to,
            bytes: Buffer.byteLength(msg.content, 'utf8'),
            delivered
          });
          notifyWatchers(to, envelope.timestamp);
          break;

        case 'watch':
          if (!clientId) {
            ws.send(JSON.stringify({ type: 'error', message: 'Register before watching' }));
            return;
          }
          if (typeof msg.for !== 'string' || !msg.for.trim()) {
            ws.send(JSON.stringify({ type: 'error', message: 'Watch target must be a client ID' }));
            return;
          }
          removeWatcher(ws);
          ws.watchTarget = msg.for.trim();
          if (!watchers.has(ws.watchTarget)) watchers.set(ws.watchTarget, new Set());
          watchers.get(ws.watchTarget).add(ws);
          ws.send(JSON.stringify({ type: 'watching', for: ws.watchTarget }));
          logger.info('watch_started', { clientId, for: ws.watchTarget });
          break;

        case 'get_history':
          if (!clientId) {
            ws.send(JSON.stringify({ type: 'error', message: 'Register before reading history' }));
            return;
          }
          const result = messageStore.query({
            requester: clientId,
            count: msg.count,
            from: msg.from,
            to: msg.to,
            after: msg.after
          });
          ws.send(JSON.stringify({
            type: 'history',
            messages: result.messages,
            cursor: result.cursor
          }));
          break;

        case 'clear_history':
          const clearedCount = messageStore.clearCache();
          ws.send(JSON.stringify({
            type: 'history_cleared',
            cleared: clearedCount,
            durableHistoryPreserved: true
          }));
          logger.info('history_cache_cleared', { clientId, cleared: clearedCount });
          break;

        case 'purge_history':
          if (!clientId || !ADMIN_CLIENT_IDS.has(clientId)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Durable history purge is not authorized' }));
            logger.warn('history_purge_rejected', { clientId: clientId || 'unregistered' });
            return;
          }
          const purgeResult = messageStore.purge();
          ws.send(JSON.stringify({ type: 'history_purged', ...purgeResult }));
          logger.warn('history_purged', { clientId, ...purgeResult });
          break;

        case 'get_peers':
          // Return list of connected peers
          ws.send(JSON.stringify({
            type: 'peers',
            peers: Array.from(clients.keys()),
            self: clientId
          }));
          break;

        case 'get_sessions':
          // Return every currently-connected session with its metadata, so any
          // peer can render the whole cluster (not just its local registry.json).
          const sessions = {};
          for (const id of clients.keys()) {
            sessions[id] = clientMeta.get(id) || {};
          }
          ws.send(JSON.stringify({
            type: 'sessions',
            sessions,
            self: clientId
          }));
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;

        default:
          logger.warn('unknown_message_type', { clientId, messageType: msg.type });
      }
    } catch (err) {
      logger.error('message_processing_failed', { clientId, error: err.message });
      ws.send(JSON.stringify({
        type: 'error',
        message: err.message
      }));
    }
  });

  ws.on('close', () => {
    removeWatcher(ws);
    if (clientId) {
      const wasLiveClient = clients.get(clientId) === ws;
      if (clients.get(clientId) === ws) {
        clients.delete(clientId);
        clientMeta.delete(clientId);
      }
      logger.info('client_disconnected', { clientId });

      if (wasLiveClient) {
        // Notify others
        broadcast({
          type: 'peer_left',
          clientId,
          peers: Array.from(clients.keys())
        });
      }
    }
  });

  ws.on('error', (err) => {
    logger.error('websocket_error', { clientId, error: err.message });
  });
});

// Detect connections whose underlying socket died without a clean close
// (crash, network drop, sleep/wake) -- otherwise a stale entry lingers in
// `clients` forever, permanently rejecting the real client's reconnects as
// "duplicate client ID".
const HEARTBEAT_INTERVAL_MS = 30000;
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      logger.warn('unresponsive_connection_terminated', { clientId: ws.clientId || null });
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeatInterval));
const retentionInterval = setInterval(() => {
  messageStore.prune();
  logger.prune();
}, 60 * 60 * 1000);
wss.on('close', () => clearInterval(retentionInterval));

function broadcast(message, excludeClient = null) {
  const data = JSON.stringify(message);
  clients.forEach((ws, id) => {
    if (id !== excludeClient && ws.readyState === 1) {
      ws.send(data);
    }
  });
}

function notifyWatchers(to, at) {
  const targets = to === 'all' ? Array.from(watchers.keys()) : [to];
  for (const target of targets) {
    const subscribers = watchers.get(target);
    if (!subscribers) continue;
    const ping = JSON.stringify({ type: 'new_message', for: target, at });
    for (const watcher of subscribers) {
      if (watcher.readyState === 1) watcher.send(ping);
    }
  }
}

function removeWatcher(ws) {
  if (!ws.watchTarget) return;
  const subscribers = watchers.get(ws.watchTarget);
  if (subscribers) {
    subscribers.delete(ws);
    if (subscribers.size === 0) watchers.delete(ws.watchTarget);
  }
  ws.watchTarget = null;
}

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('server_stopping', { signal: 'SIGINT' });
  wss.close(() => {
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  logger.info('server_stopping', { signal: 'SIGTERM' });
  wss.close(() => process.exit(0));
});
