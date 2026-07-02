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

const PORT = parseInt(process.argv[2] || process.env.RELAY_PORT || '9999', 10);
const MAX_HISTORY = 100;

// Connected clients: Map<clientId, WebSocket>
const clients = new Map();
// Message history for late joiners
const messageHistory = [];

const wss = new WebSocketServer({ host: '0.0.0.0', port: PORT });

console.log(`[Claude Relay] Server starting on port ${PORT}...`);

wss.on('listening', () => {
  console.log(`[Claude Relay] Ready! Listening on ws://0.0.0.0:${PORT} (all interfaces)`);
});

wss.on('connection', (ws, req) => {
  let clientId = null;

  console.log(`[Claude Relay] New connection from ${req.socket.remoteAddress}`);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'register':
          // Client identifies itself (M1, M2, etc.)
          const requestedClientId = msg.clientId || 'unknown';
          const existingClient = clients.get(requestedClientId);
          if (existingClient && existingClient !== ws && existingClient.readyState === 1) {
            ws.send(JSON.stringify({
              type: 'error',
              message: `Client ID ${requestedClientId} is already connected`
            }));
            console.log(`[Claude Relay] Rejected duplicate client ID: ${requestedClientId}`);
            ws.close(1008, 'duplicate client ID');
            return;
          }

          clientId = requestedClientId;
          clients.set(clientId, ws);
          console.log(`[Claude Relay] Client registered: ${clientId}`);

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
          // Relay message to target(s)
          const envelope = {
            type: 'message',
            from: clientId,
            to: msg.to || 'all',
            content: msg.content,
            timestamp: new Date().toISOString()
          };

          // Store in history
          messageHistory.push(envelope);
          if (messageHistory.length > MAX_HISTORY) {
            messageHistory.shift();
          }

          if (msg.to && msg.to !== 'all') {
            // Direct message to specific client
            const target = clients.get(msg.to);
            if (target && target.readyState === 1) {
              target.send(JSON.stringify(envelope));
              console.log(`[Claude Relay] ${clientId} -> ${msg.to}: ${msg.content.substring(0, 50)}...`);
            } else {
              ws.send(JSON.stringify({
                type: 'error',
                message: `Client ${msg.to} not connected`
              }));
            }
          } else {
            // Broadcast to all except sender
            broadcast(envelope, clientId);
            console.log(`[Claude Relay] ${clientId} -> all: ${msg.content.substring(0, 50)}...`);
          }
          break;

        case 'get_history':
          // Return recent message history
          const count = Math.min(msg.count || 10, MAX_HISTORY);
          const from = msg.from; // Optional filter
          let history = messageHistory.slice(-count);

          if (from) {
            history = history.filter(m => m.from === from);
          }

          ws.send(JSON.stringify({
            type: 'history',
            messages: history
          }));
          break;

        case 'clear_history':
          // Clear in-memory message history
          const clearedCount = messageHistory.length;
          messageHistory.length = 0;
          ws.send(JSON.stringify({
            type: 'history_cleared',
            cleared: clearedCount
          }));
          console.log(`[Claude Relay] Cleared ${clearedCount} message(s) from history`);
          break;

        case 'get_peers':
          // Return list of connected peers
          ws.send(JSON.stringify({
            type: 'peers',
            peers: Array.from(clients.keys()),
            self: clientId
          }));
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;

        default:
          console.log(`[Claude Relay] Unknown message type: ${msg.type}`);
      }
    } catch (err) {
      console.error(`[Claude Relay] Error processing message:`, err.message);
      ws.send(JSON.stringify({
        type: 'error',
        message: err.message
      }));
    }
  });

  ws.on('close', () => {
    if (clientId) {
      const wasLiveClient = clients.get(clientId) === ws;
      if (clients.get(clientId) === ws) {
        clients.delete(clientId);
      }
      console.log(`[Claude Relay] Client disconnected: ${clientId}`);

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
    console.error(`[Claude Relay] WebSocket error for ${clientId}:`, err.message);
  });
});

function broadcast(message, excludeClient = null) {
  const data = JSON.stringify(message);
  clients.forEach((ws, id) => {
    if (id !== excludeClient && ws.readyState === 1) {
      ws.send(data);
    }
  });
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Claude Relay] Shutting down...');
  wss.close(() => {
    console.log('[Claude Relay] Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  wss.close(() => process.exit(0));
});
