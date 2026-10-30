#!/usr/bin/env node
// The ONE view of Claude relay sessions.
//
// One table, one line per session, real state checked at print time:
//   PROCESS  — is the session's OS process actually running right now (kill -0)
//   RELAY    — does it have a live connection to the relay server right now
//
// Sources are merged and verified, never trusted: the registry file
// (~/claude-relay/sessions/registry.json) supplies remembered names and the
// relay server supplies live connections. A name whose process is gone and
// has no relay connection is history: it is listed once below the table, not
// as a row. It is never deleted here — its registry entry is what a restarted
// session in the same folder reclaims, and only bridges (under the registry
// lock) write that file.
//
// Usage:
//   status.js                all sessions
//   status.js --connected    only sessions with a live relay connection

const fs = require('fs');
const os = require('os');
const path = require('path');

const REGISTRY = path.join(os.homedir(), 'claude-relay', 'sessions', 'registry.json');
const RELAY_URL = process.env.RELAY_URL || 'ws://localhost:9999';
const HOST = os.hostname().split('.')[0];
const connectedOnly = process.argv.includes('--connected');

function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  } catch {
    return {};
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function loadWs() {
  try {
    return require(path.join(os.homedir(), 'claude-relay', 'node_modules', 'ws'));
  } catch {
    try {
      return require('ws');
    } catch {
      return null;
    }
  }
}

// Ask the relay server who is connected right now. Resolves to null when the
// server is unreachable (relay states then show as "unknown").
function fetchLiveSessions() {
  const WebSocket = loadWs();
  if (!WebSocket) return Promise.resolve(null);
  return new Promise(resolve => {
    let settled = false;
    const done = value => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let ws;
    try {
      ws = new WebSocket(RELAY_URL);
    } catch {
      return done(null);
    }
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch {}
      done(null);
    }, 2000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'get_sessions' })));
    ws.on('message', data => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'sessions') {
          clearTimeout(timer);
          ws.close();
          done(msg.sessions || {});
        }
      } catch {}
    });
    ws.on('error', () => {
      clearTimeout(timer);
      done(null);
    });
  });
}

(async () => {
  const registry = readRegistry();
  const live = await fetchLiveSessions();
  const ids = [...new Set([...Object.keys(registry), ...Object.keys(live || {})])].sort();

  const rows = [];
  const gone = [];
  for (const id of ids) {
    const reg = registry[id];
    const conn = live ? live[id] : undefined;
    const pid = conn?.pid ?? reg?.pid ?? null;
    const remote = Boolean(conn?.host && conn.host !== HOST);
    const alive = remote || pidAlive(pid);
    const connected = live === null ? null : Boolean(conn);

    // History, not state: shown once below the table, kept in the registry.
    if (!alive && connected === false) {
      const ended = reg?.ended && !Number.isNaN(Date.parse(reg.ended))
        ? `ended ${new Date(reg.ended).toISOString().slice(0, 16).replace('T', ' ')} UTC`
        : 'bridge exited';
      gone.push(`${id} (${ended})`);
      continue;
    }
    if (connectedOnly && !connected) continue;

    rows.push({
      id,
      pid: pid ? String(pid) : '-',
      process: remote ? `remote:${conn.host}` : alive ? 'alive' : 'dead',
      relay: connected === null ? 'unknown' : connected ? 'connected' : 'NO RELAY',
      cwd: (conn?.cwd || reg?.cwd || '-').replace(os.homedir(), '~')
    });
  }

  const header = { id: 'NAME', pid: 'PID', process: 'PROCESS', relay: 'RELAY', cwd: 'CWD' };
  const widths = {};
  for (const key of Object.keys(header)) {
    widths[key] = Math.max(header[key].length, ...rows.map(r => r[key].length), 1);
  }
  const fmt = r =>
    [r.id.padEnd(widths.id), r.pid.padEnd(widths.pid), r.process.padEnd(widths.process),
     r.relay.padEnd(widths.relay), r.cwd].join('  ');

  console.log(`=== Claude Relay Sessions${connectedOnly ? ' (connected only)' : ''} ===`);
  if (live === null) console.log('(relay server unreachable — RELAY column unknown)');
  console.log(fmt(header));
  rows.forEach(r => console.log(fmt(r)));
  if (!rows.length) console.log('(none)');
  if (!connectedOnly && gone.length) {
    console.log(`\nNot running (${gone.length}), kept so a restart gets its name back: ${gone.join(', ')}`);
  }
  if (!connectedOnly && rows.some(r => r.relay === 'NO RELAY')) {
    console.log('\nNO RELAY = the process is running but has no relay connection, so it');
    console.log('cannot send or receive messages (its relay MCP is not running/connected).');
  }
})();
