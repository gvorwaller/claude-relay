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

// Cross-process lock for registry read-modify-write. Every bridge used to
// read the whole file, edit one entry, and rename its own copy over the top —
// so two concurrent connects/renames silently lost one update (review finding
// #9). mkdir is the atomic primitive; the owner token means a stale-lock
// breaker can never delete a live holder's lock.
const REGISTRY_LOCK = `${REGISTRY_FILE}.lock`;
const LOCK_STALE_MS = 10000;

function withRegistryLock(fn) {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + 5000;
  let held = false;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(REGISTRY_LOCK);
      fs.writeFileSync(path.join(REGISTRY_LOCK, 'owner'), `${token}\n${process.pid}`, { mode: 0o600 });
      held = true;
      break;
    } catch {
      // Break a lock only when its recorded holder is provably gone. Age
      // alone is not evidence: a live-but-paused holder would otherwise have
      // a second writer started underneath it.
      try {
        const [, holderPid] = fs.readFileSync(path.join(REGISTRY_LOCK, 'owner'), 'utf8').split('\n');
        const pid = Number(holderPid);
        let holderAlive = true;
        if (pid) {
          try { process.kill(pid, 0); } catch (err) { holderAlive = err.code !== 'ESRCH' ? true : false; }
        } else {
          // No recorded pid (older format): fall back to age.
          const stat = fs.statSync(REGISTRY_LOCK);
          holderAlive = Date.now() - stat.mtimeMs <= LOCK_STALE_MS;
        }
        if (!holderAlive) {
          fs.rmSync(REGISTRY_LOCK, { recursive: true, force: true });
          continue;
        }
      } catch { /* lock vanished or unreadable; retry */ }
      const until = Date.now() + 5;
      while (Date.now() < until) { /* brief spin; critical sections are sub-ms */ }
    }
  }
  // FAIL CLOSED. Running the transaction unlocked restores the lost-update
  // race the lock exists to prevent (re-check #1).
  if (!held) {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'registry_lock_timeout',
      action: 'skipped registry update rather than racing'
    }));
    return undefined;
  }
  try {
    return fn();
  } finally {
    try {
      const [owner] = fs.readFileSync(path.join(REGISTRY_LOCK, 'owner'), 'utf8').split('\n');
      if (owner === token) fs.rmSync(REGISTRY_LOCK, { recursive: true, force: true });
    } catch { /* already broken by a stale-breaker */ }
  }
}

function writeRegistryAtomic(registry) {
  const tmpFile = `${REGISTRY_FILE}.${process.pid}.tmp`;
  const handle = fs.openSync(tmpFile, 'w', 0o600);
  try {
    fs.writeSync(handle, JSON.stringify(registry, null, 2));
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(tmpFile, REGISTRY_FILE);
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

// true = alive, false = dead, null = no/unreadable pid (treated as claimable)
function registryPidAlive(info) {
  const pid = Number(info && info.pid);
  if (!pid) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM' ? true : err.code === 'ESRCH' ? false : null;
  }
}

function findRegisteredSessionId(baseId, cwd, registry = readRegistry()) {
  if (!baseId) return null;

  // Labels are pid-anchored: a registry entry whose recorded bridge pid is
  // verifiably ALIVE belongs to a running session — claiming it would only be
  // rejected by the server, so it is excluded here. A dead (or unrecorded)
  // pid means the label is ours to reclaim: this is what lets a restarted
  // session land directly back on its old label with no relay_rename step.
  const claimable = ([id, info]) =>
    sameCwd(cwd, info?.cwd) && registryPidAlive(info) !== true;

  if (registry[baseId] && claimable([baseId, registry[baseId]])) {
    return { id: baseId, source: 'registry-exact' };
  }

  const numberedPattern = new RegExp(`^${escapeRegExp(baseId)}\\d+$`);
  const matches = Object.entries(registry)
    .filter(([id, info]) => numberedPattern.test(id) && claimable([id, info]))
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

// Delegate mode: this bridge reads and answers mail FOR an existing label
// (set by the server's wake hook via wake-codex.sh) without ever owning it.
// The server assigns the actual visible ID (`<base>~wake-<pid>`); labels stay
// pid-anchored to the interactive session that owns them.
let DELEGATE_FOR = (process.env.RELAY_DELEGATE_FOR || '').trim() || null;

// Codex spawns MCP servers with a curated environment (config.toml env only),
// so RELAY_DELEGATE_FOR set by wake-codex.sh never arrives. Detect the
// situation from process ancestry instead: a bridge whose parent is a
// `codex exec ...` headless run IS a wake/one-off and must act as a delegate
// of whatever label it would have resolved — never own it.
// Resolve THIS bridge's owning Codex conversation once, at startup, from
// process ancestry: the parent codex process holds its rollout file open.
// Persisting it (review finding #6) lets a wake resume the exact session
// instead of guessing "newest rollout in the same cwd", which could inject
// one session's mail into another conversation. Ambiguity yields null — the
// wake then refuses and notifies rather than resuming the wrong thread.
function detectCodexSessionId() {
  try {
    const parentPid = psField(process.ppid, 'pid') ? process.ppid : null;
    if (!parentPid) return null;
    const lsof = require('child_process')
      .execSync(`lsof -p ${parentPid} 2>/dev/null || true`, { encoding: 'utf8', timeout: 5000 });
    const matches = [...new Set(
      (lsof.match(/\/[^\s]*rollout-[^\s]*\.jsonl/g) || [])
    )];
    if (matches.length !== 1) return null;
    const uuid = path.basename(matches[0], '.jsonl')
      .replace(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, '');
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid) ? uuid : null;
  } catch {
    return null;
  }
}

function detectCodexHeadless() {
  const parentArgs = psField(process.ppid, 'args');
  if (/(^|\/)codex\S*\s+(-\S+\s+)*exec\b/.test(parentArgs)) {
    return `parent is codex exec: ${parentArgs.slice(0, 100)}`;
  }
  return null;
}

const resolvedIdentity = resolveClientIdentity();
if (!DELEGATE_FOR) {
  const headlessReason = detectCodexHeadless();
  if (headlessReason) {
    DELEGATE_FOR = resolvedIdentity.id;
    console.error(`[Claude Relay MCP] Headless codex run detected (${headlessReason}); acting as delegate of "${DELEGATE_FOR}".`);
  }
}
// An explicit --client-id is deliberate even in a fork; every other source is
// (potentially) inherited environment, so a background fork gets a derived,
// collision-free identity instead.
if (resolvedIdentity.source !== '--client-id' && !DELEGATE_FOR) {
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
// Recorded for primary sessions only: a delegate's own rollout is the same
// conversation, and delegates never write the registry.
const CODEX_SESSION_ID = DELEGATE_FOR ? null : detectCodexSessionId();

if (DELEGATE_FOR) {
  resolvedIdentity.id = `${DELEGATE_FOR}~wake-${process.pid}`;
  resolvedIdentity.source = 'delegate';
  resolvedIdentity.note =
    `Delegate mode (RELAY_DELEGATE_FOR): reading and answering mail for "${DELEGATE_FOR}" ` +
    `without owning that label; the server assigns this bridge a derived ID.`;
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
  // Delegates are transient helpers acting for a label someone else owns;
  // they must never write the label->pid registry.
  if (DELEGATE_FOR) return;
  try {
    withRegistryLock(() => {
    let registry = readRegistry();

    if (action === 'connect') {
      registry[CLIENT_ID] = {
        pid: process.pid,
        started: new Date().toISOString(),
        cwd: process.cwd(),
        relayUrl: RELAY_URL,
        source: CLIENT_ID_SOURCE,
        // Exact owning Codex conversation, when unambiguously resolvable.
        ...(CODEX_SESSION_ID ? { codexSessionId: CODEX_SESSION_ID } : {})
      };
    } else if (action === 'release') {
      // Deliberate abandonment (relay_rename away from a wrong identity):
      // the mapping is incorrect, so it must not survive for reclaim.
      delete registry[CLIENT_ID];
    } else if (action === 'disconnect' && (CLIENT_ID_SOURCE === 'auto' || CLIENT_ID_SOURCE === 'background-fork')) {
      // Throwaway identities (hostname-pid, bg-fork suffixes) never recur;
      // drop them so they don't clutter the registry.
      delete registry[CLIENT_ID];
    } else if (action === 'disconnect') {
      // Keep the label->cwd mapping on clean exit (marked ended, pid now
      // dead). This is what a restarted session in the same cwd reclaims —
      // deleting it here is why restarts used to come up auto-numbered.
      if (registry[CLIENT_ID]) {
        registry[CLIENT_ID].ended = new Date().toISOString();
      }
    }

    writeRegistryAtomic(registry);
    });
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
  return withRegistryLock(() => clearRegistrySessionsLocked());
}

function clearRegistrySessionsLocked() {
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

  writeRegistryAtomic(kept);

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
// Set when the server refuses our label because a verified-live local process
// owns it (pid-anchored ownership). Like displacement, auto-reconnect is
// suspended: retrying the same register would be refused forever. relay_rename
// picks a new ID (or retries this one once the owner is gone).
let rejectedReason = null;
// In-flight transactional rename: {requestId, oldId, oldSource, newId,
// reclaiming, timer}. Committed on `registered`, rolled back untouched on
// `register_rejected` — local identity/registry never change speculatively.
let pendingRename = null;
// A rename requested while disconnected: announced on the next connect and
// committed only when the server confirms it.
let desiredRename = null;
let peers = [];
let pendingMessages = [];
let messageQueue = [];
let reconnectTimer = null;
let shuttingDown = false;

function commitRename(rename, suffix = '') {
  clearTimeout(rename.timer);
  if (!rename.reclaiming) {
    // CLIENT_ID is still the old identity here — nothing changed
    // speculatively. Release the wrong mapping, then record the new one.
    updateRegistry('release');
    CLIENT_ID = rename.newId;
    CLIENT_ID_SOURCE = 'rename';
    updateRegistry('connect');
  }
  displaced = false;
  rejectedReason = null;
  let text = rename.reclaiming
    ? `Reclaimed relay identity "${rename.newId}". ${suffix}`
    : `Renamed relay identity: ${rename.oldId} → ${rename.newId}, confirmed by the relay server. ${suffix}`;
  text += `\nNote: tool descriptions cached by this client may still show "${rename.oldId}" until the tool list refreshes; relay_status always shows the current identity.`;
  sendToolText(rename.requestId, text.trim());
  pendingRename = null;
}

function sendToolText(requestId, text) {
  sendMcpResponse({
    jsonrpc: '2.0',
    id: requestId,
    result: { content: [{ type: 'text', text }] }
  });
}

const relayWaiter = new RelayWaiter({
  respond: sendToolText,
  onFinish: ({ requestId }) => {
    const waitHistory = pendingMessages.find(p =>
      p.type === 'wait_history' && p.requestId === requestId);
    if (waitHistory) {
      waitHistory.settled = true;
      if (!waitHistory.historyRequested) {
        pendingMessages = pendingMessages.filter(p => p !== waitHistory);
      }
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'attention_wait_cancel', waitId: String(requestId) }));
    }
  },
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
            },
            {
              name: 'relay_delegate_jobs',
              description: 'Preview terminal detached-delegate job records by exact owner or all owners. Restricted to configured admin client IDs; returns the confirmation token required by relay_purge_delegate_jobs.',
              inputSchema: {
                type: 'object',
                properties: {
                  owner: {
                    type: 'string',
                    description: 'Exact relay identity (for example CODEX1), or "all"'
                  }
                },
                required: ['owner']
              }
            },
            {
              name: 'relay_purge_delegate_jobs',
              description: 'Delete terminal detached-delegate job records for one owner or all owners. Restricted to configured admin client IDs and requires the exact token from relay_delegate_jobs. Active jobs are never selected or deleted.',
              inputSchema: {
                type: 'object',
                properties: {
                  owner: {
                    type: 'string',
                    description: 'Exact relay identity used in the preview, or "all"'
                  },
                  confirmation: {
                    type: 'string',
                    description: 'Exact confirmation token returned by relay_delegate_jobs'
                  }
                },
                required: ['owner', 'confirmation']
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

      // Respond from the server's ack so the sender learns the truth:
      // delivered live vs queued for an offline peer. The fallback timer keeps
      // the tool call from hanging if the ack never arrives (old server).
      const preview = `"${args.message.substring(0, 100)}${args.message.length > 100 ? '...' : ''}"`;
      const sendAck = {
        requestId,
        type: 'send_ack',
        to: args.to || 'all',
        preview
      };
      sendAck.timer = setTimeout(() => {
        pendingMessages = pendingMessages.filter(p => p !== sendAck);
        sendToolText(requestId, `Message sent to ${sendAck.to === 'all' ? 'all peers' : sendAck.to}: ${preview}`);
      }, 3000);
      pendingMessages.push(sendAck);

      ws.send(JSON.stringify({
        type: 'message',
        to: args.to || 'all',
        content: args.message
      }));
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

      // Tell the relay that this foreground tool owns the next matching
      // attention event BEFORE asking for history. WebSocket ordering makes
      // the claim visible before the history request, so a newly arriving
      // message cannot also wake the detached delegate and Stop-hook watcher.
      pendingMessages.push({
        requestId,
        type: 'wait_history',
        waitId: String(requestId),
        historyRequested: false,
        settled: false,
        from: args.from,
        after: args.after
      });
      ws.send(JSON.stringify({
        type: 'attention_wait',
        waitId: String(requestId),
        from: args.from || null,
        after: args.after || null
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

    case 'relay_delegate_jobs':
    case 'relay_purge_delegate_jobs': {
      if (!connected) {
        sendMcpResponse({
          jsonrpc: '2.0', id: requestId,
          result: { content: [{ type: 'text', text: 'Not connected to relay server. Unable to administer delegate jobs.' }] }
        });
        return;
      }
      const requestType = toolName === 'relay_delegate_jobs'
        ? 'preview_delegate_jobs'
        : 'purge_delegate_jobs';
      const operationId = `${requestType}-${Date.now()}-${Math.random()}`;
      pendingMessages.push({ requestId, type: requestType, id: operationId });
      ws.send(JSON.stringify({
        type: requestType,
        owner: args.owner,
        ...(requestType === 'purge_delegate_jobs' ? { confirmation: args.confirmation } : {})
      }));
      setTimeout(() => {
        const idx = pendingMessages.findIndex(p => p.id === operationId);
        if (idx !== -1) {
          pendingMessages.splice(idx, 1);
          sendMcpResponse({
            jsonrpc: '2.0', id: requestId,
            result: { content: [{ type: 'text', text: 'Timeout waiting for relay server to administer delegate jobs' }] }
          });
        }
      }, 3000);
      break;
    }

    case 'relay_status':
      sendMcpResponse({
        jsonrpc: '2.0',
        id: requestId,
        result: {
          content: [{
            type: 'text',
            text: connected
              ? `Connected to ${RELAY_URL} as "${CLIENT_ID}"${DELEGATE_FOR ? ` (delegate of ${DELEGATE_FOR}: reads and sends its mail, does not own the label)` : ''}. Peers online: ${peers.length > 0 ? peers.filter(p => p !== CLIENT_ID).join(', ') || 'none' : 'checking...'}`
              : rejectedReason
                ? `REJECTED: ${rejectedReason} This session is NOT auto-reconnecting (the owner would refuse it again). Call relay_rename with a different ID, or stop the owning process and relay_rename back to "${CLIENT_ID}".`
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
      if (newId === CLIENT_ID && !displaced && !rejectedReason) {
        sendToolText(requestId, `Already registered as "${CLIENT_ID}" — nothing to do.`);
        return;
      }
      const oldId = CLIENT_ID;
      const reclaiming = newId === CLIENT_ID;

      // Connected path is TRANSACTIONAL (review finding #5): nothing local —
      // not CLIENT_ID, not the registry — changes until the server confirms
      // with `registered`. A rejection leaves the old identity fully intact.
      if (connected && ws && ws.readyState === WebSocket.OPEN) {
        if (pendingRename) {
          sendToolText(requestId,
            `A rename to "${pendingRename.newId}" is already awaiting server confirmation; retry once it settles.`);
          return;
        }
        pendingRename = {
          requestId,
          oldId,
          oldSource: CLIENT_ID_SOURCE,
          newId,
          reclaiming
        };
        // NEVER infer success from silence (review re-check #7): a late
        // rejection after an optimistic commit produces local/server
        // split-brain. Every server acks a register with `registered` or
        // `register_rejected`; a timeout here means "unknown", so we roll
        // back and let the operator retry.
        pendingRename.timer = setTimeout(() => {
          if (!pendingRename || pendingRename.requestId !== requestId) return;
          // Silence is genuinely UNKNOWN: the server may have applied the
          // rename and lost the ack. Asserting "nothing changed" would be
          // split-brain in the other direction (re-check #8), so force the
          // ambiguity away — drop the socket (the server releases whichever
          // label it holds) and reconnect under the old identity.
          const attempted = pendingRename.newId;
          pendingRename = null;
          // Poison this socket generation, then hard-terminate: the server
          // releases whatever label it held, and any ack still in flight is
          // discarded rather than silently changing our identity.
          socketGeneration += 1;
          try { if (ws) ws.terminate(); } catch { /* already gone */ }
          sendToolText(requestId,
            `No response from the relay server for the rename to "${attempted}" — outcome unknown. `
            + `This connection was dropped and is reconnecting as "${CLIENT_ID}"; `
            + 'confirm with relay_status before relying on either identity.');
        }, 30000); // must exceed the server's worst-case liveness probe
        registerWithServer(newId);
        break;
      }

      // Disconnected path: nothing may be committed locally before the
      // server accepts the claim (re-check #6). Record the intent; the
      // reconnect announces it and the `registered` handler commits.
      if (!reclaiming) {
        desiredRename = { oldId, newId };
      }
      displaced = false;
      rejectedReason = null;

      let renameText = reclaiming
        ? `Reclaiming relay identity "${CLIENT_ID}".`
        : `Rename to "${newId}" is PENDING: still "${CLIENT_ID}" until the relay server confirms.`;
      if (!reconnectTimer) {
        connectToRelay();
        renameText += ` Reconnecting to the relay server; "${CLIENT_ID}" will be announced as soon as the connection is up.`;
      } else {
        renameText += ' Relay server unreachable right now; the new ID will be announced automatically on the next (re)connect.';
      }
      renameText += `\nIf "${CLIENT_ID}" is held by another connection whose process is verifiably alive on the relay host, that registration will be rejected (labels are pid-anchored) — check relay_status.`;
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
// Owner capabilities live outside the shared registry, one 0600 file per
// label, so a label's authority is never readable from a file peers share.
const OWNERS_DIR = path.join(SESSIONS_DIR, 'owners');

function ownerSecretPath(label) {
  return path.join(OWNERS_DIR, `${label}.secret`);
}

function readOwnerSecret(label) {
  try {
    return fs.readFileSync(ownerSecretPath(label), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// Durable, atomic, and permission-verified: the one-time plaintext must
// survive a crash mid-write, and an existing loose-permission file must be
// repaired rather than trusted (re-check #11).
function writeOwnerSecret(label, secret) {
  try {
    fs.mkdirSync(OWNERS_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(OWNERS_DIR, 0o700);
    const target = ownerSecretPath(label);
    const tmp = `${target}.${process.pid}.tmp`;
    const handle = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(handle, secret);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(tmp, target);
    fs.chmodSync(target, 0o600);
    try {
      const dirFd = fs.openSync(OWNERS_DIR, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch { /* directory fsync unsupported */ }
    return readOwnerSecret(label) === secret;
  } catch (err) {
    console.error(`[Claude Relay MCP] Could not persist owner capability for ${label}: ${err.message}`);
    return false;
  }
}

// The wake hook hands the single-use job capability over in a 0600 file
// rather than an env value, so it never appears in `ps` output.
function readJobToken() {
  const file = process.env.RELAY_JOB_TOKEN_FILE;
  if (!file) return null;
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    try { fs.unlinkSync(file); } catch { /* best effort */ }
    return token || null;
  } catch {
    return null;
  }
}
const JOB_TOKEN = readJobToken();

function registerWithServer(idOverride) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  const claimedId = DELEGATE_FOR || idOverride || (desiredRename ? desiredRename.newId : CLIENT_ID);
  const registration = {
    type: 'register',
    clientId: claimedId,
    ...(DELEGATE_FOR
      ? (JOB_TOKEN ? { jobToken: JOB_TOKEN } : {})
      : (readOwnerSecret(claimedId) ? { ownerSecret: readOwnerSecret(claimedId) } : {})),
    // Enrollment material is sent ONLY when this label has no capability yet
    // (i.e. we may actually need to enroll). Broadcasting it on every
    // registration is needless bearer exposure on a plaintext ws:// link.
    ...(process.env.RELAY_ENROLL_SECRET && !DELEGATE_FOR && !readOwnerSecret(claimedId)
      ? { enrollSecret: process.env.RELAY_ENROLL_SECRET }
      : {}),
    meta: {
      pid: process.pid,
      started: STARTED_AT,
      cwd: process.cwd(),
      host: HOST,
      source: CLIENT_ID_SOURCE,
      relayUrl: RELAY_URL
    }
  };
  if (DELEGATE_FOR) registration.delegate = true;
  ws.send(JSON.stringify(registration));
  return true;
}

let socketGeneration = 0;

function connectToRelay() {
  if (ws) {
    ws.close();
  }

  socketGeneration += 1;
  const generation = socketGeneration;
  ws = new WebSocket(RELAY_URL);
  ws.generation = generation;

  ws.on('open', () => {
    if (generation !== socketGeneration) {
      try { ws.terminate(); } catch { /* already gone */ }
      return;
    }
    connected = true;
    // Register with relay, reporting metadata so peers on other machines can see
    // this session in the cluster-wide list (get_sessions), not just locally.
    // The local registry is written only once the server CONFIRMS the
    // identity: a rejected claim used to leave a live-pid entry (with its
    // codexSessionId) for a label this bridge never owned, which a wake could
    // then resume into the wrong conversation (re-check #7).
    registerWithServer();
  });

  ws.on('message', (data) => {
    // Frames from a superseded socket (e.g. a rename ack that arrived after
    // we gave up waiting) must not mutate identity: that was split-brain in
    // the opposite direction (re-check #6).
    if (generation !== socketGeneration) return;
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'registered':
          peers = msg.peers || [];
          // A newly enrolled label's owner capability arrives exactly once —
          // persist it durably BEFORE anything else claims the identity is
          // established, or the server holds an enrollment whose only
          // plaintext was lost.
          if (msg.ownerSecret && msg.clientId) {
            if (writeOwnerSecret(msg.clientId, msg.ownerSecret)) {
              // Phase 2: tell the server the capability is durably ours.
              // Until this lands the label stays in its migration window, so
              // a lost secret never leaves an unreclaimable enrollment.
              try {
                ws.send(JSON.stringify({
                  type: 'ack_enrollment',
                  clientId: msg.clientId,
                  ownerSecret: msg.ownerSecret
                }));
              } catch { /* connection died; enrollment stays pending */ }
            } else {
              console.error(JSON.stringify({
                timestamp: new Date().toISOString(),
                event: 'owner_capability_persist_failed',
                clientId: msg.clientId,
                action: 'not acknowledging enrollment; label stays reclaimable'
              }));
            }
          }
          // Server confirmed a rename we asked for while disconnected.
          if (desiredRename && msg.clientId === desiredRename.newId) {
            const previous = CLIENT_ID;
            CLIENT_ID = desiredRename.oldId;
            updateRegistry('release');
            CLIENT_ID = desiredRename.newId;
            CLIENT_ID_SOURCE = 'rename';
            updateRegistry('connect');
            console.error(`[Claude Relay MCP] Rename confirmed on reconnect: ${previous} → ${CLIENT_ID}`);
            desiredRename = null;
            break;
          }
          // Server confirmed this identity: only now is it safe to record it
          // locally as ours.
          if (!DELEGATE_FOR && msg.clientId === CLIENT_ID && !pendingRename) {
            updateRegistry('connect');
          }
          if (pendingRename && msg.clientId === pendingRename.newId) {
            // Server confirmed the rename: commit identity + registry now.
            commitRename(pendingRename);
            break;
          }
          // Adopt the server-assigned ID (differs from ours only in delegate
          // mode, where the server mints the visible `<base>~wake-<pid>` ID).
          if (msg.clientId && msg.clientId !== CLIENT_ID) {
            CLIENT_ID = msg.clientId;
          }
          break;

        case 'register_rejected':
          if (pendingRename && msg.clientId === pendingRename.newId) {
            // A failed RENAME is not a failed session: the server never
            // touched our old identity, this socket is still registered as
            // it, and nothing local changed. Report and carry on.
            clearTimeout(pendingRename.timer);
            sendToolText(pendingRename.requestId,
              `Rename to "${pendingRename.newId}" rejected: ${msg.reason || 'label is owned by a live process'}\n`
              + `Still connected and registered as "${CLIENT_ID}"; the registry is unchanged.`);
            pendingRename = null;
            break;
          }
          if (desiredRename && msg.clientId === desiredRename.newId) {
            // The OLD identity was never given up, so drop the intent and
            // reconnect as ourselves rather than going dark (re-check #4).
            console.error(`[Claude Relay MCP] Rename to ${desiredRename.newId} refused; keeping ${CLIENT_ID}`);
            desiredRename = null;
            try { if (ws) ws.close(); } catch { /* already closing */ }
            if (!reconnectTimer) {
              reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                connectToRelay();
              }, 1000);
            }
            break;
          }
          rejectedReason = msg.reason || `Label "${msg.clientId}" is owned by a live process`;
          console.error(JSON.stringify({
            timestamp: new Date().toISOString(),
            event: 'relay_register_rejected',
            clientId: CLIENT_ID,
            holderPid: msg.holderPid || null,
            action: 'suspending reconnect; use relay_rename to take a different ID'
          }));
          // The socket is up but we hold no identity on it: reflect that
          // immediately (relay_status must not claim "Connected as X" while
          // the close is still in flight), then close and stay down (the
          // close handler sees rejectedReason and will not retry).
          connected = false;
          ws.close();
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

        case 'attention_waiting': {
          const waitReq = pendingMessages.find(p =>
            p.type === 'wait_history' && p.waitId === String(msg.waitId || ''));
          if (waitReq && !waitReq.settled && !waitReq.historyRequested) {
            waitReq.historyRequested = true;
            ws.send(JSON.stringify({
              type: 'get_history',
              count: 100,
              from: waitReq.from,
              after: waitReq.after
            }));
          }
          break;
        }

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
            if (msg.unknownCursor) {
              text = `Warning: the "after" cursor was not found (expired, pruned, or foreign) — nothing was replayed. Call relay_receive WITHOUT "after" to resync, then continue from the new cursor.\n${text}`;
            }
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

        case 'delegate_jobs_preview': {
          const previewReq = pendingMessages.find(p => p.type === 'preview_delegate_jobs');
          if (previewReq) {
            pendingMessages = pendingMessages.filter(p => p !== previewReq);
            const statuses = Object.entries(msg.byStatus || {})
              .map(([status, count]) => `${status}=${count}`).join(', ') || 'none';
            const owners = Object.entries(msg.byOwner || {})
              .map(([owner, count]) => `${owner}=${count}`).join(', ') || 'none';
            sendMcpResponse({
              jsonrpc: '2.0', id: previewReq.requestId,
              result: { content: [{
                type: 'text',
                text: msg.count
                  ? `Preview: ${msg.count} terminal delegate-job record(s) for ${msg.owner}. Statuses: ${statuses}. Owners: ${owners}. To delete exactly this selection, call relay_purge_delegate_jobs with owner="${msg.owner}" and confirmation="${msg.confirmation}".`
                  : `Preview: no terminal delegate-job records for ${msg.owner}; nothing to purge.`
              }] }
            });
          }
          break;
        }

        case 'delegate_jobs_purged': {
          const purgeJobsReq = pendingMessages.find(p => p.type === 'purge_delegate_jobs');
          if (purgeJobsReq) {
            pendingMessages = pendingMessages.filter(p => p !== purgeJobsReq);
            sendMcpResponse({
              jsonrpc: '2.0', id: purgeJobsReq.requestId,
              result: { content: [{
                type: 'text',
                text: `Purged ${msg.purged || 0} terminal delegate-job record(s) for ${msg.owner}. Active jobs were preserved.`
              }] }
            });
          }
          break;
        }

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

        case 'sent':
          // Server ack for relay_send: delivered live vs durably queued.
          const sendReq = pendingMessages.find(p => p.type === 'send_ack');
          if (sendReq) {
            pendingMessages = pendingMessages.filter(p => p !== sendReq);
            clearTimeout(sendReq.timer);
            const label = sendReq.to === 'all' ? 'all peers' : sendReq.to;
            const text = msg.delivered
              ? (sendReq.to === 'all'
                ? `Broadcast to ${label} (at least one peer connected): ${sendReq.preview}`
                : `Sent to ${label} (connection live — delivered; note a live socket doesn't guarantee attention): ${sendReq.preview}`)
              : `Queued for ${label} (offline — stored durably, replayed when they next read): ${sendReq.preview}`;
            sendToolText(sendReq.requestId, text);
          }
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
          const pendingPurge = pendingMessages.find(p => [
            'purge_history', 'preview_delegate_jobs', 'purge_delegate_jobs'
          ].includes(p.type));
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
    if (generation !== socketGeneration) return; // superseded socket: no-op
    connected = false;
    peers = [];
    if (pendingRename) {
      // The socket died before the server could confirm or reject: nothing
      // local changed, so the rename simply did not happen.
      clearTimeout(pendingRename.timer);
      sendToolText(pendingRename.requestId,
        `Relay disconnected before the rename to "${pendingRename.newId}" was confirmed; identity unchanged ("${CLIENT_ID}").`);
      pendingRename = null;
    }
    relayWaiter.finish('disconnect');
    // Any in-flight history response belonged to this closed socket and can
    // never arrive. Do not let its tombstone consume a post-reconnect reply.
    pendingMessages = pendingMessages.filter(p => p.type !== 'wait_history');
    // Attempt reconnect after delay — unless displaced (reconnecting under a
    // taken-over ID just re-seizes it and starts an endless takeover fight)
    // or rejected (the label's live owner would refuse us again forever).
    if (DELEGATE_FOR && !shuttingDown) {
      // Its job capability was consumed at registration and cannot be reused,
      // so reconnecting would produce a connected-but-unregistered zombie
      // whose relay_receive never resolves. End the delegate instead.
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        event: 'delegate_socket_closed',
        clientId: CLIENT_ID,
        action: 'exiting; a delegate job capability is single-use'
      }));
      process.exit(0);
    }
    if (!shuttingDown && !displaced && !rejectedReason) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectToRelay();
      }, 5000);
    }
  });

  ws.on('error', () => {
    if (generation !== socketGeneration) return; // superseded socket: no-op
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
