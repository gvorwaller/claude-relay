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
const { RelayWaiter } = require('./relay-waiter');

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

// Pick the next unused `${baseId}N` suffix, treating a bare baseId entry as
// implicitly "1". Used when baseId is already claimed by a different cwd, so
// a shared/global RELAY_CLIENT_ID (e.g. Codex Desktop's fixed "CODEX") can't
// collide with a session already registered under that name.
function nextAvailableNumberedId(baseId, registry) {
  const numberedPattern = new RegExp(`^${escapeRegExp(baseId)}(\\d+)$`);
  let maxN = 1;
  for (const id of Object.keys(registry)) {
    const match = id.match(numberedPattern);
    if (match) maxN = Math.max(maxN, parseInt(match[1], 10));
  }
  return `${baseId}${maxN + 1}`;
}

function resolveClientIdentity() {
  if (sessionId) {
    return { id: sessionId, source: 'CLAUDE_RELAY_SESSION_ID' };
  }

  if (cliClientId) {
    return { id: cliClientId, source: '--client-id' };
  }

  const registry = readRegistry();
  const registryMatch = findRegisteredSessionId(configuredClientId, process.cwd(), registry);
  if (registryMatch?.id) {
    return {
      id: registryMatch.id,
      source: registryMatch.source,
      note: `Resolved ${registryMatch.id} from registry cwd ${process.cwd()}`
    };
  }

  if (configuredClientId) {
    if (registry[configuredClientId]) {
      // Base ID is already claimed by a different cwd (we'd have matched
      // above otherwise) -- mint a fresh numbered variant instead of
      // colliding with whatever's already registered as configuredClientId.
      const newId = nextAvailableNumberedId(configuredClientId, registry);
      return {
        id: newId,
        source: 'auto-numbered',
        note: `Base ID "${configuredClientId}" already registered for cwd ${registry[configuredClientId].cwd}; auto-assigned ${newId} for this cwd (${process.cwd()})`
      };
    }
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

function psField(pid, field) {
  try {
    return require('child_process')
      .execSync(`ps -o ${field}= -p ${pid}`, { encoding: 'utf8', timeout: 2000 })
      .trim();
  } catch {
    return '';
  }
}

// Background forks of a Claude session (subagent forks, background-daemon
// resumes, scheduled runs) inherit CLAUDE_RELAY_SESSION_ID / RELAY_CLIENT_ID
// from the original session and would otherwise register under the SAME
// identity, seizing it from the real session in an endless takeover fight
// (observed 2026-07-21: a --fork-session orphan and a --bg-pty-host daemon
// resume both stole "CC2" from the live terminal session). Detect that
// context and refuse to claim the inherited ID verbatim.
function detectBackgroundFork() {
  if (process.env.RELAY_BACKGROUND_FORK === '1') return 'RELAY_BACKGROUND_FORK=1';
  const parentArgs = psField(process.ppid, 'args');
  if (/--fork-session\b/.test(parentArgs)) return 'parent has --fork-session';
  const grandparentPid = psField(process.ppid, 'ppid');
  if (grandparentPid && /--bg-pty-host\b/.test(psField(grandparentPid, 'args'))) {
    return 'grandparent is --bg-pty-host daemon';
  }
  return null;
}

const resolvedIdentity = resolveClientIdentity();
// An explicit --client-id is deliberate even in a fork; every other source is
// (potentially) inherited environment, so a background fork gets a derived,
// collision-free identity instead.
if (resolvedIdentity.source !== '--client-id') {
  const forkReason = detectBackgroundFork();
  if (forkReason) {
    const baseId = resolvedIdentity.id;
    resolvedIdentity.id = `${baseId}-bg${process.pid.toString(36)}`;
    resolvedIdentity.source = 'background-fork';
    resolvedIdentity.note =
      `Background fork detected (${forkReason}); registering as ${resolvedIdentity.id} ` +
      `instead of seizing "${baseId}" from the live session that owns it.`;
  }
}
// Mutable: relay_rename lets a live session correct its identity at runtime
// (no restart, no env vars) when startup resolution picked the wrong ID.
let CLIENT_ID = resolvedIdentity.id;
let CLIENT_ID_SOURCE = resolvedIdentity.source;
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

    const tmpFile = `${REGISTRY_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(registry, null, 2));
    fs.renameSync(tmpFile, REGISTRY_FILE);
  } catch (err) {
    // Non-fatal: don't interrupt MCP operation for registry issues
  }
}

/**
 * Clear the local session registry, keeping only sessions that are currently
 * online (this session plus live peers). Backs up the registry first.
 * Purely local: registry.json only exists on this machine, so no relay
 * server round-trip is needed and this works while disconnected.
 */
function clearRegistrySessions() {
  const registry = readRegistry();
  const online = new Set(peers);
  online.add(CLIENT_ID);

  const removed = [];
  const kept = {};
  for (const [id, info] of Object.entries(registry)) {
    if (online.has(id)) {
      kept[id] = info;
    } else {
      removed.push(id);
    }
  }

  if (removed.length === 0) {
    return { removed, kept: Object.keys(kept), backup: null };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(SESSIONS_DIR, 'backups');
  const backupFile = path.join(backupDir, `registry-${stamp}.json`);
  let backup = null;
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(REGISTRY_FILE, backupFile);
    backup = backupFile;
  } catch {
    // Backup is best-effort; still proceed with the clear
  }

  const tmpFile = `${REGISTRY_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(kept, null, 2));
  fs.renameSync(tmpFile, REGISTRY_FILE);

  return { removed, kept: Object.keys(kept), backup };
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
// Set when the server tells us a newer connection re-registered our ID
// (newest-wins takeover). A displaced client must NOT auto-reconnect under
// the same ID — that guarantees an eternal 5-second takeover ping-pong with
// the new holder. It goes quiet instead; relay_status explains, and
// relay_rename (to a new ID, or the same ID to deliberately reclaim it)
// re-establishes the connection.
let displaced = false;
let peers = [];
let pendingMessages = [];
let messageQueue = [];
let reconnectTimer = null;
let shuttingDown = false;

function sendToolText(requestId, text) {
  sendMcpResponse({
    jsonrpc: '2.0',
    id: requestId,
    result: { content: [{ type: 'text', text }] }
  });
}

const relayWaiter = new RelayWaiter({
  respond: sendToolText,
  log: fields => console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    event: 'relay_wait_completed',
    ...fields
  }))
});

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
                  },
                  to: {
                    type: 'string',
                    description: 'Filter messages by recipient ID (optional)'
                  },
                  after: {
                    type: 'string',
                    description: 'Return messages after this message ID or ISO timestamp (optional)'
                  }
                }
              }
            },
            {
              name: 'relay_wait',
              description: 'Wait for the next authorized relay message without polling the relay server',
              inputSchema: {
                type: 'object',
                properties: {
                  from: { type: 'string', description: 'Only return messages from this exact peer ID' },
                  after: { type: 'string', description: 'Return messages after this durable message ID or ISO timestamp' },
                  timeoutSeconds: {
                    type: 'number',
                    minimum: 1,
                    maximum: 300,
                    default: 240
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
              name: 'relay_rename',
              description: 'Rename this session\'s relay identity at runtime — no restart or environment variables needed. Re-registers with the relay server under the new ID (the old ID is released immediately) and updates the local session registry. Use when this session connected under the wrong ID (e.g. as "CODEX" when it should be "CODEX1"), or — if relay_status reports this session was DISPLACED — pass the current ID to deliberately reclaim it.',
              inputSchema: {
                type: 'object',
                properties: {
                  to: {
                    type: 'string',
                    description: 'New session ID to register as (e.g. "CODEX1"). Letters, digits, "-" and "_" only, must start with a letter.'
                  }
                },
                required: ['to']
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
              name: 'relay_clear_sessions',
              description: 'Clear the local session registry (registry.json), removing all offline sessions. Currently online sessions (this one and live peers) are preserved. The registry is backed up first. Typical use: after a reboot or when a session host died.',
              inputSchema: {
                type: 'object',
                properties: {}
              }
            },
            {
              name: 'relay_clear_history',
              description: 'Clear the relay server memory cache while preserving the durable seven-day journal',
              inputSchema: {
                type: 'object',
                properties: {}
              }
            },
            {
              name: 'relay_purge_history',
              description: 'Delete durable relay message history (restricted to configured admin client IDs)',
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

    case 'relay_wait':
      if (!connected) {
        sendToolText(requestId, `Relay is disconnected. No cursor was advanced.\nCursor: ${args.after || 'none'}`);
        return;
      }
      if (!relayWaiter.start({
        requestId,
        from: args.from,
        after: args.after,
        timeoutSeconds: args.timeoutSeconds
      })) {
        sendMcpResponse({
          jsonrpc: '2.0',
          id: requestId,
          error: { code: -32000, message: 'A relay_wait call is already active in this MCP process' }
        });
        return;
      }

      // Register the waiter before asking for history. Push and history then
      // race through RelayWaiter.finish(), whose first settlement wins.
      pendingMessages.push({ requestId, type: 'wait_history' });
      ws.send(JSON.stringify({
        type: 'get_history',
        count: 100,
        from: args.from,
        after: args.after
      }));
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
        from: args.from,
        to: args.to,
        after: args.after
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

    case 'relay_purge_history':
      if (!connected) {
        sendMcpResponse({
          jsonrpc: '2.0',
          id: requestId,
          result: { content: [{ type: 'text', text: 'Not connected to relay server. Unable to purge message history.' }] }
        });
        return;
      }

      const purgeHistoryRequestId = Date.now();
      pendingMessages.push({ requestId, type: 'purge_history', id: purgeHistoryRequestId });
      ws.send(JSON.stringify({ type: 'purge_history' }));
      setTimeout(() => {
        const idx = pendingMessages.findIndex(p => p.id === purgeHistoryRequestId);
        if (idx !== -1) {
          pendingMessages.splice(idx, 1);
          sendMcpResponse({
            jsonrpc: '2.0',
            id: requestId,
            result: { content: [{ type: 'text', text: 'Timeout waiting for relay server to purge history' }] }
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
              : displaced
                ? `DISPLACED: a newer connection re-registered "${CLIENT_ID}", so this session disconnected and is NOT auto-reconnecting (that would start a takeover fight). If this session should own "${CLIENT_ID}", call relay_rename with to="${CLIENT_ID}" to deliberately reclaim it; otherwise call relay_rename with a different ID.`
                : `Disconnected from relay server. Attempting to connect to ${RELAY_URL}...`
          }]
        }
      });
      break;

    case 'relay_rename': {
      const newId = String(args.to || '').trim();
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(newId)) {
        sendToolText(requestId, `Error: invalid session ID "${newId}". Use letters, digits, "-" or "_", starting with a letter (max 64 chars).`);
        return;
      }
      if (newId === CLIENT_ID && !displaced) {
        sendToolText(requestId, `Already registered as "${CLIENT_ID}" — nothing to do.`);
        return;
      }
      const oldId = CLIENT_ID;
      const reclaiming = newId === CLIENT_ID;
      // Release the old identity's registry entry with the same semantics as a
      // disconnect (registry-sourced IDs are marked ended, others removed),
      // then claim the new identity locally and on the server. A same-ID call
      // while displaced is a deliberate reclaim (newest registration wins).
      if (!reclaiming) {
        updateRegistry('disconnect');
        CLIENT_ID = newId;
        CLIENT_ID_SOURCE = 'rename';
        updateRegistry('connect');
      }
      displaced = false;

      let renameText = reclaiming
        ? `Reclaiming relay identity "${CLIENT_ID}".`
        : `Renamed relay identity: ${oldId} → ${CLIENT_ID}.`;
      if (registerWithServer()) {
        renameText += ' Re-registered with the relay server; the old ID was released immediately.';
      } else if (!reconnectTimer) {
        connectToRelay();
        renameText += ` Reconnecting to the relay server; "${CLIENT_ID}" will be announced as soon as the connection is up.`;
      } else {
        renameText += ' Relay server unreachable right now; the new ID will be announced automatically on the next (re)connect.';
      }
      renameText += `\nIf "${CLIENT_ID}" was live on another connection, that connection has been displaced (newest registration wins). Peers should message ${CLIENT_ID} from now on.`;
      renameText += `\nNote: tool descriptions cached by this client may still show "${oldId}" until the tool list refreshes; relay_status always shows the current identity.`;
      sendToolText(requestId, renameText);
      break;
    }

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

    case 'relay_clear_sessions': {
      let text;
      try {
        const { removed, kept, backup } = clearRegistrySessions();
        if (removed.length === 0 && kept.length === 0) {
          text = 'Session registry is already empty.';
        } else if (removed.length === 0) {
          text = `Nothing to clear: all ${kept.length} registered session(s) are currently online (${kept.join(', ')}).`;
        } else {
          text = `Cleared ${removed.length} offline session(s): ${removed.join(', ')}\n`;
          text += `Kept (online): ${kept.length ? kept.join(', ') : 'none'}\n`;
          text += backup ? `Backup: ${backup}` : 'Backup failed (registry cleared anyway)';
        }
      } catch (err) {
        text = `Failed to clear session registry: ${err.message}`;
      }
      sendToolText(requestId, text);
      break;
    }

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

/**
 * (Re-)announce this client's identity and metadata to the relay server.
 * Used on socket open and by relay_rename (the server treats a register from
 * an already-registered socket as a rename and drops the old identity).
 */
function registerWithServer() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
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
  return true;
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
    registerWithServer();
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
          const histReq = pendingMessages.find(p => p.type === 'history' || p.type === 'wait_history');
          if (histReq) {
            pendingMessages = pendingMessages.filter(p => p !== histReq);
            const messages = msg.messages || [];
            if (histReq.type === 'wait_history') {
              // This may be the losing half of a push/history race. In that
              // case it is deliberately consumed without a second response.
              console.error(JSON.stringify({
                timestamp: new Date().toISOString(),
                event: 'relay_wait_history_received',
                messageCount: messages.length
              }));
              relayWaiter.deliverHistory(messages);
              break;
            }
            let text = messages.length > 0
              ? messages.map(m => `[${m.timestamp}] ${m.from}: ${m.content}`).join('\n')
              : 'No messages in history';
            if (msg.cursor) text += `\n\nCursor: ${msg.cursor}`;
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
                  text: `Cleared ${msg.cleared || 0} message(s) from the memory cache; durable history was preserved`
                }]
              }
            });
          }
          break;

        case 'history_purged':
          const purgeReq = pendingMessages.find(p => p.type === 'purge_history');
          if (purgeReq) {
            pendingMessages = pendingMessages.filter(p => p !== purgeReq);
            sendMcpResponse({
              jsonrpc: '2.0',
              id: purgeReq.requestId,
              result: {
                content: [{
                  type: 'text',
                  text: `Purged ${msg.filesDeleted || 0} durable history file(s) and ${msg.cacheCleared || 0} cached message(s)`
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
          // Keep nonmatching messages available to relay_receive. A matching
          // active waiter is settled directly by the pushed durable envelope.
          messageQueue.push({
            type: 'message',
            id: msg.id,
            from: msg.from,
            to: msg.to,
            content: msg.content,
            timestamp: msg.timestamp
          });
          relayWaiter.deliver(msg, 'push');
          break;

        case 'error':
          if (/re-registered by a newer connection/.test(msg.message || '')) {
            displaced = true;
            console.error(JSON.stringify({
              timestamp: new Date().toISOString(),
              event: 'relay_identity_displaced',
              clientId: CLIENT_ID,
              action: 'suspending reconnect; use relay_rename to reclaim or take a new ID'
            }));
            break;
          }
          const pendingPurge = pendingMessages.find(p => p.type === 'purge_history');
          if (pendingPurge) {
            pendingMessages = pendingMessages.filter(p => p !== pendingPurge);
            sendMcpResponse({
              jsonrpc: '2.0',
              id: pendingPurge.requestId,
              result: { content: [{ type: 'text', text: `Error: ${msg.message}` }] }
            });
          }
          break;
      }
    } catch {
      // Ignore parse errors
    }
  });

  ws.on('close', () => {
    connected = false;
    peers = [];
    relayWaiter.finish('disconnect');
    // Any in-flight history response belonged to this closed socket and can
    // never arrive. Do not let its tombstone consume a post-reconnect reply.
    pendingMessages = pendingMessages.filter(p => p.type !== 'wait_history');
    // Attempt reconnect after delay — unless displaced: reconnecting under a
    // taken-over ID just re-seizes it and starts an endless takeover fight.
    if (!shuttingDown && !displaced) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectToRelay();
      }, 5000);
    }
  });

  ws.on('error', () => {
    // Error will trigger close, which handles reconnect
  });
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  relayWaiter.finish('cancel');
  if (reconnectTimer) clearTimeout(reconnectTimer);
  updateRegistry('disconnect');
  if (ws) ws.close();
}

// Handle shutdown
process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});

process.on('SIGTERM', () => {
  shutdown();
  process.exit(0);
});

rl.on('close', () => {
  shutdown();
  process.exit(0);
});

// Also clean up on normal exit
process.on('exit', () => {
  shutdown();
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
    shutdown();
    process.exit(0);
  }
}

// Start watchdog after a brief delay to let initialization complete
setTimeout(() => {
  setInterval(checkParentAlive, WATCHDOG_INTERVAL);
}, 5000);
