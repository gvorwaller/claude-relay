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

const path = require('path');
const { WebSocketServer } = require('ws');
const { MessageStore } = require('./message-store');
const { OperationalLogger } = require('./operational-logger');
const { NotifyHooks } = require('./notify-hooks');

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
const notifyHooks = new NotifyHooks({
  configPath: process.env.RELAY_NOTIFY_CONFIG || path.join(__dirname, 'data', 'notify.json'),
  logger
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

          // Delegate registration: a helper the server's own wake hook spawned
          // (e.g. a resumed headless Codex run) that must read and answer mail
          // for an existing label WITHOUT owning it. It gets a visibly derived
          // ID and never contests the base label, so the interactive session
          // holding that label is untouched.
          if (msg.delegate === true) {
            if (!isLoopback(req.socket.remoteAddress)) {
              ws.send(JSON.stringify({
                type: 'error',
                message: 'Delegate registration is only permitted from the relay host'
              }));
              return;
            }
            if (clientId && !ws.delegateOf) {
              // A primary switching itself to delegate mode would leave its
              // old label mapped to this socket while authorization changed
              // underneath it (review finding #10). Fresh connections only.
              ws.send(JSON.stringify({
                type: 'error',
                message: `Already registered as "${clientId}"; delegate registration requires a fresh connection`
              }));
              return;
            }
            const delegateBase = String(requestedClientId);
            const delegatePid = msg.meta && msg.meta.pid ? msg.meta.pid : Date.now().toString(36);
            const delegateId = `${delegateBase}~wake-${delegatePid}`;
            const staleDelegate = clients.get(delegateId);
            if (staleDelegate && staleDelegate !== ws) staleDelegate.terminate();
            clientId = delegateId;
            ws.clientId = delegateId;
            ws.delegateOf = delegateBase;
            clients.set(delegateId, ws);
            clientMeta.set(delegateId, {
              ...(msg.meta && typeof msg.meta === 'object' ? msg.meta : {}),
              delegateOf: delegateBase,
              remoteAddress: req.socket.remoteAddress,
              connectedAt: new Date().toISOString()
            });
            logger.info('delegate_registered', { delegateId, delegateOf: delegateBase });
            ws.send(JSON.stringify({
              type: 'registered',
              clientId: delegateId,
              delegateOf: delegateBase,
              peers: Array.from(clients.keys()).filter(id => id !== delegateId)
            }));
            broadcast({
              type: 'peer_joined',
              clientId: delegateId,
              peers: Array.from(clients.keys())
            }, delegateId);
            break;
          }

          if (ws.delegateOf) {
            // The mirror image: a delegate must not shed its restrictions by
            // re-registering as a primary on the same socket.
            ws.send(JSON.stringify({
              type: 'error',
              message: `This connection is a delegate of "${ws.delegateOf}"; primary registration requires a fresh connection`
            }));
            return;
          }

          // Same-socket rename: this connection is already registered under a
          // different ID (relay_rename). The old identity is dropped ONLY
          // after the new label's contest is won — destroying it first left a
          // rejected renamer identity-less and unroutable (review finding #5).
          const renamedFrom =
            clientId && clientId !== requestedClientId && clients.get(clientId) === ws
              ? clientId
              : null;

          const existingClient = clients.get(requestedClientId);
          if (existingClient && existingClient !== ws && existingClient.readyState === 1) {
            // Pid-anchored ownership (2026-08-05): a label belongs to the
            // process that registered it, for that process's lifetime. The
            // old newest-wins takeover guessed which claimant was real; when
            // the holder is local its pid makes that checkable, so we check
            // instead of guessing:
            //   - same pid re-registering        -> reseat (reconnect)
            //   - holder pid dead                -> label was orphaned; reassign
            //   - holder pid verifiably alive    -> REJECT the newcomer
            //   - holder remote / pid unknown    -> legacy newest-wins
            const verdict = contestLabel(requestedClientId, existingClient, msg.meta);
            if (verdict.action === 'reject') {
              logger.warn('register_rejected_label_owned', {
                clientId: requestedClientId,
                holderPid: verdict.holderPid,
                newRemoteAddress: req.socket.remoteAddress
              });
              ws.send(JSON.stringify({
                type: 'register_rejected',
                clientId: requestedClientId,
                holderPid: verdict.holderPid,
                reason: `"${requestedClientId}" is owned by live pid ${verdict.holderPid} on the relay host. `
                  + 'Labels are pid-anchored: stop that process, or register under a different ID '
                  + '(or as its delegate).'
              }));
              return;
            }
            if (verdict.action === 'takeover') {
              // Liveness unverifiable (remote holder or no reported pid):
              // keep the newest-wins behavior this path was built for.
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
            } else {
              logger.info(verdict.action === 'reseat' ? 'label_reseated_same_pid' : 'orphaned_label_reclaimed', {
                clientId: requestedClientId,
                holderPid: verdict.holderPid
              });
            }
            existingClient.displacedByTakeover = true;
            existingClient.terminate();
          }

          // Contest won (or uncontested): now it is safe to release the
          // renamed-from identity.
          if (renamedFrom) {
            clients.delete(renamedFrom);
            clientMeta.delete(renamedFrom);
            logger.info('client_renamed', {
              from: renamedFrom,
              to: requestedClientId,
              remoteAddress: req.socket.remoteAddress
            });
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

          // Broadcast peer update to others. On a rename, first announce the
          // old identity leaving so every peer's cached list converges.
          if (renamedFrom) {
            broadcast({
              type: 'peer_left',
              clientId: renamedFrom,
              peers: Array.from(clients.keys())
            }, clientId);
          }
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
          // A delegate speaks AS its base label: its mail is stored from the
          // base so peers see one consistent identity and the base session
          // keeps visibility of the conversation.
          const fromId = ws.delegateOf || clientId;
          // Direct mail reaches the label's owner AND any live delegates of it.
          const directSockets = [];
          if (to !== 'all') {
            const primary = clients.get(to);
            if (primary && primary.readyState === 1) directSockets.push(primary);
            for (const peer of clients.values()) {
              if (peer.delegateOf === to && peer.readyState === 1 && peer !== ws) {
                directSockets.push(peer);
              }
            }
          }
          const deliveredToDelegate = directSockets.some(peer => peer.delegateOf === to);
          const delivered = to === 'all'
            ? Array.from(clients.entries()).some(([id, peer]) => id !== clientId && peer.readyState === 1)
            : directSockets.length > 0;
          const envelope = messageStore.append({
            type: 'message',
            from: fromId,
            to,
            content: msg.content,
            delivered
          });

          if (msg.to && msg.to !== 'all') {
            for (const peer of directSockets) {
              peer.send(JSON.stringify(envelope));
            }
          } else {
            // Broadcast to all except sender
            broadcast(envelope, clientId);
          }
          // Always acknowledge honestly. An offline target used to get an
          // 'error' reply even though the message WAS durably stored and will
          // be replayed — that lie caused real triage confusion (2026-08-02
          // incident). delivered=false now means "queued", never "lost".
          ws.send(JSON.stringify({
            type: 'sent',
            id: envelope.id,
            to,
            delivered
          }));
          logger.info('message_recorded', {
            messageId: envelope.id,
            from: fromId,
            sentBy: fromId === clientId ? undefined : clientId,
            to,
            bytes: Buffer.byteLength(msg.content, 'utf8'),
            delivered
          });
          notifyWatchers(to, envelope.timestamp, fromId);
          notifyHooks.fire({
            to,
            from: fromId,
            messageId: envelope.id,
            delivered,
            deliveredToDelegate
          });
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
          // Closing the re-arm blind window: a watcher re-subscribing every
          // ~300s is deaf between exits. With `since` (message id or ISO
          // timestamp) the server checks the store at subscribe time and pings
          // immediately if mail already arrived, so gap mail wakes the next
          // watcher the instant it arms instead of sitting silent.
          if (typeof msg.since === 'string' && msg.since.trim()) {
            const pending = messageStore.query({
              requester: ws.watchTarget,
              after: msg.since.trim(),
              count: 50
            }).messages.filter(m =>
              m.from !== ws.watchTarget && (m.to === ws.watchTarget || m.to === 'all'));
            if (pending.length > 0) {
              ws.send(JSON.stringify({
                type: 'new_message',
                for: ws.watchTarget,
                at: pending[pending.length - 1].timestamp,
                pending: pending.length
              }));
              logger.info('watch_backfill_ping', {
                clientId,
                for: ws.watchTarget,
                pending: pending.length
              });
            }
          }
          break;

        case 'get_history':
          if (!clientId) {
            ws.send(JSON.stringify({ type: 'error', message: 'Register before reading history' }));
            return;
          }
          // A delegate reads with its base label's visibility — that is the
          // entire reason it exists (mail is addressed to the base).
          const result = messageStore.query({
            requester: ws.delegateOf || clientId,
            count: msg.count,
            from: msg.from,
            to: msg.to,
            after: msg.after
          });
          ws.send(JSON.stringify({
            type: 'history',
            messages: result.messages,
            cursor: result.cursor,
            unknownCursor: result.unknownCursor
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

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

// true = alive, false = dead, null = unknowable from this process
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') return true;
    if (err.code === 'ESRCH') return false;
    return null;
  }
}

function contestLabel(labelId, holder, newMeta) {
  const holderMeta = clientMeta.get(labelId) || {};
  const holderPid = Number(holderMeta.pid) || null;
  const newPid = newMeta && Number(newMeta.pid) ? Number(newMeta.pid) : null;
  if (holderPid && newPid && holderPid === newPid) return { action: 'reseat', holderPid };
  const holderLocal = isLoopback(holder._socket && holder._socket.remoteAddress);
  if (holderLocal && holderPid) {
    const alive = pidAlive(holderPid);
    if (alive === true) return { action: 'reject', holderPid };
    if (alive === false) return { action: 'orphan', holderPid };
  }
  return { action: 'takeover', holderPid };
}

function broadcast(message, excludeClient = null) {
  const data = JSON.stringify(message);
  clients.forEach((ws, id) => {
    if (id !== excludeClient && ws.readyState === 1) {
      ws.send(data);
    }
  });
}

function notifyWatchers(to, at, from) {
  const targets = to === 'all' ? Array.from(watchers.keys()) : [to];
  for (const target of targets) {
    // A broadcast must not wake the sender's own watcher — an agent pinging
    // itself awake over its own outbound mail would loop forever.
    if (from && target === from) continue;
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
