#!/usr/bin/env node
/**
 * Claude Relay MCP Server
 *
 * MCP server that provides tools for Claude Code to communicate
 * with peer instances via the WebSocket relay.
 *
 * Usage: node mcp-server.js [--client-id=M2] [--relay-url=ws://localhost:9999]
 *
 * Environment variables:
 *   RELAY_CLIENT_ID - Client identifier (M1, M2, etc.)
 *   RELAY_URL - WebSocket relay server URL
 */

const WebSocket = require('ws');
const readline = require('readline');
const os = require('os');

// Configuration from args or env
const args = process.argv.slice(2).reduce((acc, arg) => {
  const [key, val] = arg.replace(/^--/, '').split('=');
  acc[key] = val;
  return acc;
}, {});

// If explicit client-id provided, use as-is; otherwise add PID suffix for uniqueness
const explicitId = args['client-id'] || process.env.RELAY_CLIENT_ID;
const baseId = explicitId || os.hostname().split('.')[0].toUpperCase();
const suffix = process.pid.toString(36);
const CLIENT_ID = explicitId ? baseId : `${baseId}-${suffix}`;
const RELAY_URL = args['relay-url'] || process.env.RELAY_URL || 'ws://localhost:9999';

// State
let ws = null;
let connected = false;
let peers = [];
let pendingMessages = [];
let messageQueue = [];

// MCP protocol handler
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

// Read JSON-RPC messages from stdin
let buffer = '';
rl.on('line', (line) => {
  buffer += line;
  try {
    const message = JSON.parse(buffer);
    buffer = '';
    handleMcpMessage(message);
  } catch {
    // Incomplete JSON, wait for more
  }
});

function sendMcpResponse(response) {
  const json = JSON.stringify(response);
  process.stdout.write(json + '\n');
}

function handleMcpMessage(message) {
  const { id, method, params } = message;

  switch (method) {
    case 'initialize':
      sendMcpResponse({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: {
            name: 'claude-relay',
            version: '1.0.0'
          },
          capabilities: {
            tools: {}
          }
        }
      });
      // Connect to relay after initialization
      connectToRelay();
      break;

    case 'notifications/initialized':
      // Client acknowledged initialization
      break;

    case 'tools/list':
      sendMcpResponse({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'relay_send',
              description: `Send a message to peer Claude Code instance(s). You are ${CLIENT_ID}.`,
              inputSchema: {
                type: 'object',
                properties: {
                  message: {
                    type: 'string',
                    description: 'Message content to send to peer'
                  },
                  to: {
                    type: 'string',
                    description: 'Target peer ID (e.g., "M1" or "M2") or "all" for broadcast. Default: all'
                  }
                },
                required: ['message']
              }
            },
            {
              name: 'relay_receive',
              description: 'Get recent messages from peer Claude Code instance(s)',
              inputSchema: {
                type: 'object',
                properties: {
                  count: {
                    type: 'number',
                    description: 'Maximum number of messages to retrieve (default: 10)'
                  },
                  from: {
                    type: 'string',
                    description: 'Filter messages by sender ID (optional)'
                  }
                }
              }
            },
            {
              name: 'relay_peers',
              description: 'List currently connected peer Claude Code instances',
              inputSchema: {
                type: 'object',
                properties: {}
              }
            },
            {
              name: 'relay_status',
              description: 'Check connection status to the relay server',
              inputSchema: {
                type: 'object',
                properties: {}
              }
            }
          ]
        }
      });
      break;

    case 'tools/call':
      handleToolCall(id, params.name, params.arguments || {});
      break;

    default:
      sendMcpResponse({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: `Method not found: ${method}`
        }
      });
  }
}

function handleToolCall(requestId, toolName, args) {
  switch (toolName) {
    case 'relay_send':
      if (!connected) {
        sendMcpResponse({
          jsonrpc: '2.0',
          id: requestId,
          result: {
            content: [{
              type: 'text',
              text: `Error: Not connected to relay server at ${RELAY_URL}. Is the server running?`
            }]
          }
        });
        return;
      }

      ws.send(JSON.stringify({
        type: 'message',
        to: args.to || 'all',
        content: args.message
      }));

      sendMcpResponse({
        jsonrpc: '2.0',
        id: requestId,
        result: {
          content: [{
            type: 'text',
            text: `Message sent to ${args.to || 'all peers'}: "${args.message.substring(0, 100)}${args.message.length > 100 ? '...' : ''}"`
          }]
        }
      });
      break;

    case 'relay_receive':
      if (!connected) {
        sendMcpResponse({
          jsonrpc: '2.0',
          id: requestId,
          result: {
            content: [{
              type: 'text',
              text: `Error: Not connected to relay server`
            }]
          }
        });
        return;
      }

      // Request history from server
      const historyRequestId = Date.now();
      pendingMessages.push({
        requestId,
        type: 'history',
        id: historyRequestId
      });

      ws.send(JSON.stringify({
        type: 'get_history',
        count: args.count || 10,
        from: args.from
      }));

      // Set timeout for response
      setTimeout(() => {
        const idx = pendingMessages.findIndex(p => p.id === historyRequestId);
        if (idx !== -1) {
          pendingMessages.splice(idx, 1);
          sendMcpResponse({
            jsonrpc: '2.0',
            id: requestId,
            result: {
              content: [{
                type: 'text',
                text: 'Timeout waiting for history from relay server'
              }]
            }
          });
        }
      }, 5000);
      break;

    case 'relay_peers':
      if (!connected) {
        sendMcpResponse({
          jsonrpc: '2.0',
          id: requestId,
          result: {
            content: [{
              type: 'text',
              text: `Not connected to relay server. Unable to list peers.`
            }]
          }
        });
        return;
      }

      // Request current peers
      const peersRequestId = Date.now();
      pendingMessages.push({
        requestId,
        type: 'peers',
        id: peersRequestId
      });

      ws.send(JSON.stringify({ type: 'get_peers' }));

      setTimeout(() => {
        const idx = pendingMessages.findIndex(p => p.id === peersRequestId);
        if (idx !== -1) {
          pendingMessages.splice(idx, 1);
          sendMcpResponse({
            jsonrpc: '2.0',
            id: requestId,
            result: {
              content: [{
                type: 'text',
                text: `Connected peers (cached): ${peers.length > 0 ? peers.join(', ') : 'none'}`
              }]
            }
          });
        }
      }, 3000);
      break;

    case 'relay_status':
      sendMcpResponse({
        jsonrpc: '2.0',
        id: requestId,
        result: {
          content: [{
            type: 'text',
            text: connected
              ? `Connected to ${RELAY_URL} as "${CLIENT_ID}". Peers online: ${peers.length > 0 ? peers.filter(p => p !== CLIENT_ID).join(', ') || 'none' : 'checking...'}`
              : `Disconnected from relay server. Attempting to connect to ${RELAY_URL}...`
          }]
        }
      });
      break;

    default:
      sendMcpResponse({
        jsonrpc: '2.0',
        id: requestId,
        error: {
          code: -32601,
          message: `Unknown tool: ${toolName}`
        }
      });
  }
}

function connectToRelay() {
  if (ws) {
    ws.close();
  }

  ws = new WebSocket(RELAY_URL);

  ws.on('open', () => {
    connected = true;
    // Register with relay
    ws.send(JSON.stringify({
      type: 'register',
      clientId: CLIENT_ID
    }));
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'registered':
          peers = msg.peers || [];
          break;

        case 'peers':
          peers = msg.peers || [];
          // Respond to pending peers request
          const peersReq = pendingMessages.find(p => p.type === 'peers');
          if (peersReq) {
            pendingMessages = pendingMessages.filter(p => p !== peersReq);
            sendMcpResponse({
              jsonrpc: '2.0',
              id: peersReq.requestId,
              result: {
                content: [{
                  type: 'text',
                  text: `You are: ${msg.self}\nConnected peers: ${peers.filter(p => p !== msg.self).join(', ') || 'none'}`
                }]
              }
            });
          }
          break;

        case 'history':
          const histReq = pendingMessages.find(p => p.type === 'history');
          if (histReq) {
            pendingMessages = pendingMessages.filter(p => p !== histReq);
            const messages = msg.messages || [];
            let text = messages.length > 0
              ? messages.map(m => `[${m.timestamp}] ${m.from}: ${m.content}`).join('\n')
              : 'No messages in history';
            sendMcpResponse({
              jsonrpc: '2.0',
              id: histReq.requestId,
              result: {
                content: [{
                  type: 'text',
                  text
                }]
              }
            });
          }
          break;

        case 'peer_joined':
          peers = msg.peers || [];
          // Queue notification for next relay_receive
          messageQueue.push({
            type: 'system',
            content: `Peer "${msg.clientId}" joined`,
            timestamp: new Date().toISOString()
          });
          break;

        case 'peer_left':
          peers = msg.peers || [];
          messageQueue.push({
            type: 'system',
            content: `Peer "${msg.clientId}" left`,
            timestamp: new Date().toISOString()
          });
          break;

        case 'message':
          // Incoming message from peer - queue it
          messageQueue.push({
            from: msg.from,
            content: msg.content,
            timestamp: msg.timestamp
          });
          break;

        case 'error':
          // Log errors but don't interrupt
          break;
      }
    } catch {
      // Ignore parse errors
    }
  });

  ws.on('close', () => {
    connected = false;
    peers = [];
    // Attempt reconnect after delay
    setTimeout(connectToRelay, 5000);
  });

  ws.on('error', () => {
    // Error will trigger close, which handles reconnect
  });
}

// Handle shutdown
process.on('SIGINT', () => {
  if (ws) ws.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (ws) ws.close();
  process.exit(0);
});
