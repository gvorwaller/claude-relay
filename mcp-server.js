#!/usr/bin/env node
/**
 * Claude Relay MCP Server
 *
 * MCP server that provides tools for Claude Code to communicate
 * with peer instances via the WebSocket relay.
 *
 * Usage: node mcp-server.js [--client-id=CC-1] [--relay-url=ws://localhost:9999]
 *
 * Environment variables (priority order):
 *   CLAUDE_RELAY_SESSION_ID - Preferred session ID (set via `claude-session CC-1`)
 *   RELAY_CLIENT_ID - Client identifier fallback
 *   RELAY_URL - WebSocket relay server URL
 *
 * Session Registry:
 *   Sessions are tracked in ~/claude-relay/sessions/registry.json
 *   Use `relay_sessions` MCP tool to list all registered sessions
 */

const WebSocket = require('ws');
const readline = require('readline');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Configuration from args or env
const args = process.argv.slice(2).reduce((acc, arg) => {
  const [key, val] = arg.replace(/^--/, '').split('=');
  acc[key] = val;
  return acc;
}, {});

// Session ID priority:
// CLAUDE_RELAY_SESSION_ID > --client-id > matching registry ID > RELAY_CLIENT_ID > hostname-pid
const sessionId = process.env.CLAUDE_RELAY_SESSION_ID;
const cliClientId = args['client-id'];
const configuredClientId = process.env.RELAY_CLIENT_ID;
const RELAY_URL = args['relay-url'] || process.env.RELAY_URL || 'ws://localhost:9999';

// Session registry path
const SESSIONS_DIR = path.join(os.homedir(), 'claude-relay', 'sessions');
const REGISTRY_FILE = path.join(SESSIONS_DIR, 'registry.json');

// Ensure sessions directory exists
try {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
} catch {}

/**
 * Read all sessions from registry
 */
function readRegistry() {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function sameCwd(a, b) {
  if (!a || !b) return false;
  try {
    return path.resolve(a) === path.resolve(b);
  } catch {
    return a === b;
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findRegisteredSessionId(baseId, cwd, registry = readRegistry()) {
  if (!baseId) return null;

  if (registry[baseId] && sameCwd(cwd, registry[baseId].cwd)) {
    return { id: baseId, source: 'registry-exact' };
  }

  const numberedPattern = new RegExp(`^${escapeRegExp(baseId)}\\d+$`);
  const matches = Object.entries(registry)
    .filter(([id, info]) => numberedPattern.test(id) && sameCwd(cwd, info?.cwd))
    .map(([id]) => id);

  if (matches.length === 1) {
    return { id: matches[0], source: 'registry-cwd' };
  }

  if (matches.length > 1) {
    return {
      id: null,
      source: 'registry-ambiguous',
      note: `Multiple ${baseId} registry sessions match ${cwd}: ${matches.join(', ')}`
    };
  }

  return null;
}

function resolveClientIdentity() {
  if (sessionId) {
    return { id: sessionId, source: 'CLAUDE_RELAY_SESSION_ID' };
  }

  if (cliClientId) {
    return { id: cliClientId, source: '--client-id' };
  }

  const registryMatch = findRegisteredSessionId(configuredClientId, process.cwd());
  if (registryMatch?.id) {
    return {
      id: registryMatch.id,
      source: registryMatch.source,
      note: `Resolved ${registryMatch.id} from registry cwd ${process.cwd()}`
    };
  }

  if (configuredClientId) {
    return {
      id: configuredClientId,
      source: 'RELAY_CLIENT_ID',
      note: registryMatch?.note
    };
  }

  const baseId = os.hostname().split('.')[0].toUpperCase();
  const suffix = process.pid.toString(36);
  return { id: `${baseId}-${suffix}`, source: 'auto' };
}

const resolvedIdentity = resolveClientIdentity();
const CLIENT_ID = resolvedIdentity.id;
const CLIENT_ID_SOURCE = resolvedIdentity.source;
// Stable start time for this process, reported to the relay server so peers can
// see it in the cluster-wide session list. Captured once so it survives reconnects.
const STARTED_AT = new Date().toISOString();
const HOST = os.hostname().split('.')[0];
if (resolvedIdentity.note) {
  console.error(`[Claude Relay MCP] ${resolvedIdentity.note}`);
}

/**
 * Update the session registry with this client's info
 */
function updateRegistry(action = 'connect') {
  try {
    let registry = {};
    if (fs.existsSync(REGISTRY_FILE)) {
      registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    }

    if (action === 'connect') {
      registry[CLIENT_ID] = {
        pid: process.pid,
        started: new Date().toISOString(),
        cwd: process.cwd(),
        relayUrl: RELAY_URL,
        source: CLIENT_ID_SOURCE
      };
    } else if (action === 'disconnect' && CLIENT_ID_SOURCE.startsWith('registry-')) {
      if (registry[CLIENT_ID]) {
        registry[CLIENT_ID].ended = new Date().toISOString();
      }
    } else if (action === 'disconnect') {
      delete registry[CLIENT_ID];
    }

    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
  } catch (err) {
    // Non-fatal: don't interrupt MCP operation for registry issues
  }
}

function baseSessionId(id) {
  const match = String(id).match(/^([A-Z]+)\d+$/);
  return match ? match[1] : null;
}

function identityWarnings(sessions) {
  const warnings = [];
  const online = new Set(peers);
  online.add(CLIENT_ID);

  for (const [id, info] of Object.entries(sessions)) {
    if (online.has(id)) continue;
    const base = baseSessionId(id);
    if (!base || !online.has(base)) continue;
    const baseInfo = sessions[base];
    const cwdNote = baseInfo && sameCwd(info?.cwd, baseInfo.cwd) ? ` in ${info.cwd}` : '';
    warnings.push(
      `${id} is registered but not live; ${base} is live${cwdNote}. Start that MCP process as ${id}, not ${base}.`
    );
  }

  return warnings;
}

/**
 * Render the cluster-wide session list from the relay server's authoritative
 * view (all live sessions across every machine), merging in any offline
 * sessions that only the local registry.json still remembers.
 */
function renderClusterSessions(serverSessions = {}, self = CLIENT_ID) {
  const local = readRegistry();
  const liveIds = Object.keys(serverSessions);
  let text = `=== Claude Relay Sessions (cluster-wide) ===\n`;
  text += `You are: ${CLIENT_ID}\n`;
  text += `Live sessions: ${liveIds.length ? liveIds.join(', ') : 'none'}\n\n`;

  if (liveIds.length === 0) {
    text += 'No live sessions.\n';
  }
  for (const [id, info] of Object.entries(serverSessions)) {
    const isMe = id === CLIENT_ID ? ' (this session)' : '';
    text += `${id}${isMe} [ONLINE]\n`;
    const host = info.host ? ` @ ${info.host}` : '';
    if (info.pid || host) text += `  PID: ${info.pid ?? '?'}${host}\n`;
    if (info.started) text += `  Started: ${new Date(info.started).toLocaleString()}\n`;
    if (info.cwd) text += `  CWD: ${info.cwd}\n`;
    if (info.source) text += `  Source: ${info.source}\n`;
    text += `\n`;
  }

  // Offline sessions known only from this machine's local registry.
  const offline = Object.entries(local).filter(([id]) => !serverSessions[id]);
  if (offline.length) {
    text += `--- Offline (local registry only) ---\n`;
    for (const [id, info] of offline) {
      text += `${id} [OFFLINE]\n`;
      if (info.cwd) text += `  CWD: ${info.cwd}\n`;
    }
    text += `\n`;
  }

  const warnings = identityWarnings({ ...local, ...serverSessions });
  if (warnings.length) {
    text += 'Identity warnings:\n';
    warnings.forEach(w => { text += `  - ${w}\n`; });
  }
  return text;
}

/**
 * Fallback used when the relay server is unreachable: show only what this
 * machine's local registry.json knows (the pre-cluster behavior).
 */
function renderLocalSessions(note) {
  const sessions = readRegistry();
  const sessionList = Object.entries(sessions);
  let text = `=== Registered Claude Sessions (local registry) ===\n`;
  if (note) text += `${note}\n`;
  text += `You are: ${CLIENT_ID}\n`;
  text += `Live peers: ${peers.length > 0 ? peers.join(', ') : 'none'}\n\n`;

  if (sessionList.length === 0) {
    text += 'No sessions registered.';
  } else {
    sessionList.forEach(([id, info]) => {
      const isMe = id === CLIENT_ID ? ' (this session)' : '';
      const online = peers.includes(id) || id === CLIENT_ID ? ' [ONLINE]' : '';
      text += `${id}${isMe}${online}\n`;
      text += `  PID: ${info.pid} | Started: ${new Date(info.started).toLocaleString()}\n`;
      text += `  CWD: ${info.cwd}\n`;
      text += `  Source: ${info.source}\n\n`;
    });
  }
  return text;
}

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
            },
            {
              name: 'relay_sessions',
              description: 'List all Claude sessions across the cluster (live sessions from the relay server on every machine, plus offline sessions from the local registry). Falls back to the local registry if the relay server is unreachable.',
              inputSchema: {
                type: 'object',
                properties: {}
              }
            },
            {
              name: 'relay_clear_history',
              description: 'Clear relay message history stored in relay server memory',
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

    case 'relay_sessions':
      // Ask the relay server for the whole cluster's live sessions. Fall back to
      // the local registry if we're not connected.
      if (!connected) {
        sendMcpResponse({
          jsonrpc: '2.0',
          id: requestId,
          result: {
            content: [{
              type: 'text',
              text: renderLocalSessions('(relay server unreachable — showing local registry only)')
            }]
          }
        });
        return;
      }

      const sessionsRequestId = Date.now();
      pendingMessages.push({
        requestId,
        type: 'sessions',
        id: sessionsRequestId
      });

      ws.send(JSON.stringify({ type: 'get_sessions' }));

      setTimeout(() => {
        const idx = pendingMessages.findIndex(p => p.id === sessionsRequestId);
        if (idx !== -1) {
          pendingMessages.splice(idx, 1);
          sendMcpResponse({
            jsonrpc: '2.0',
            id: requestId,
            result: {
              content: [{
                type: 'text',
                text: renderLocalSessions('(timed out waiting for relay server — showing local registry only)')
              }]
            }
          });
        }
      }, 3000);
      break;

    case 'relay_clear_history':
      if (!connected) {
        sendMcpResponse({
          jsonrpc: '2.0',
          id: requestId,
          result: {
            content: [{
              type: 'text',
              text: 'Not connected to relay server. Unable to clear message history.'
            }]
          }
        });
        return;
      }

      const clearHistoryRequestId = Date.now();
      pendingMessages.push({
        requestId,
        type: 'clear_history',
        id: clearHistoryRequestId
      });

      ws.send(JSON.stringify({ type: 'clear_history' }));

      setTimeout(() => {
        const idx = pendingMessages.findIndex(p => p.id === clearHistoryRequestId);
        if (idx !== -1) {
          pendingMessages.splice(idx, 1);
          sendMcpResponse({
            jsonrpc: '2.0',
            id: requestId,
            result: {
              content: [{
                type: 'text',
                text: 'Timeout waiting for relay server to clear history'
              }]
            }
          });
        }
      }, 3000);
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
    // Register with relay, reporting metadata so peers on other machines can see
    // this session in the cluster-wide list (get_sessions), not just locally.
    ws.send(JSON.stringify({
      type: 'register',
      clientId: CLIENT_ID,
      meta: {
        pid: process.pid,
        started: STARTED_AT,
        cwd: process.cwd(),
        host: HOST,
        source: CLIENT_ID_SOURCE,
        relayUrl: RELAY_URL
      }
    }));
    // Update local session registry
    updateRegistry('connect');
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

        case 'sessions':
          const sessReq = pendingMessages.find(p => p.type === 'sessions');
          if (sessReq) {
            pendingMessages = pendingMessages.filter(p => p !== sessReq);
            sendMcpResponse({
              jsonrpc: '2.0',
              id: sessReq.requestId,
              result: {
                content: [{
                  type: 'text',
                  text: renderClusterSessions(msg.sessions || {}, msg.self)
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

        case 'history_cleared':
          const clearReq = pendingMessages.find(p => p.type === 'clear_history');
          if (clearReq) {
            pendingMessages = pendingMessages.filter(p => p !== clearReq);
            sendMcpResponse({
              jsonrpc: '2.0',
              id: clearReq.requestId,
              result: {
                content: [{
                  type: 'text',
                  text: `Cleared ${msg.cleared || 0} message(s) from relay history`
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
  updateRegistry('disconnect');
  if (ws) ws.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  updateRegistry('disconnect');
  if (ws) ws.close();
  process.exit(0);
});

// Also clean up on normal exit
process.on('exit', () => {
  updateRegistry('disconnect');
});

/**
 * Parent process watchdog
 * MCP servers are spawned by Claude Code. If Claude Code exits unexpectedly,
 * the MCP server becomes orphaned. This watchdog detects orphaning and exits.
 */
const PARENT_PID = process.ppid;
const WATCHDOG_INTERVAL = 10000; // Check every 10 seconds

function checkParentAlive() {
  try {
    // process.kill with signal 0 checks if process exists without killing it
    process.kill(PARENT_PID, 0);
  } catch (err) {
    // Parent process is gone - we're orphaned
    updateRegistry('disconnect');
    if (ws) ws.close();
    process.exit(0);
  }
}

// Start watchdog after a brief delay to let initialization complete
setTimeout(() => {
  setInterval(checkParentAlive, WATCHDOG_INTERVAL);
}, 5000);
