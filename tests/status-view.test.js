const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const WebSocket = require('ws');

const STATUS = path.join(__dirname, '..', 'sessions', 'status.js');

function writeRegistry(root, registry) {
  const dir = path.join(root, 'claude-relay', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify(registry, null, 2));
  return path.join(dir, 'registry.json');
}

function runStatus(root, relayUrl, args = []) {
  return execFileSync(process.execPath, [STATUS, ...args], {
    env: { ...process.env, HOME: root, RELAY_URL: relayUrl },
    encoding: 'utf8'
  });
}

test('status view verifies process liveness, shows NO RELAY, and lists stopped sessions without deleting them', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-status-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), String(port)], {
    env: {
      ...process.env,
      RELAY_MESSAGE_DIR: path.join(root, 'messages'),
      RELAY_LOG_DIR: path.join(root, 'logs')
    },
    stdio: 'ignore'
  });
  t.after(() => server.kill('SIGTERM'));

  // ALIVEONE: our own live pid, registered but not relay-connected.
  // DEADGHOST: a pid that cannot exist (bridge exited without a clean end).
  // ENDEDONE: a clean exit, pid already dropped.
  const registryFile = writeRegistry(root, {
    ALIVEONE: { pid: process.pid, cwd: root, started: new Date().toISOString() },
    DEADGHOST: { pid: 99999999, cwd: root, started: new Date().toISOString() },
    ENDEDONE: { cwd: root, started: '2026-10-25T13:00:00.000Z', ended: '2026-10-25T14:03:09.000Z' }
  });
  const before = fs.readFileSync(registryFile, 'utf8');

  // CONNONE: connected to the relay but absent from the registry file.
  let conn;
  for (let attempt = 0; attempt < 100 && !conn; attempt += 1) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      const registered = new Promise(resolve => ws.on('message', d => {
        if (JSON.parse(d).type === 'registered') resolve();
      }));
      ws.send(JSON.stringify({ type: 'register', clientId: 'CONNONE', meta: { pid: process.pid, cwd: root, host: os.hostname().split('.')[0] } }));
      await registered;
      conn = ws;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  assert.ok(conn, 'relay server started');
  t.after(() => conn.close());

  const out = runStatus(root, `ws://127.0.0.1:${port}`);
  assert.match(out, /ALIVEONE\s+\d+\s+alive\s+NO RELAY/);
  assert.match(out, /CONNONE\s+\d+\s+alive\s+connected/);
  assert.doesNotMatch(out, /DEADGHOST\s+\d+\s+(alive|dead)/);
  assert.doesNotMatch(out, /ENDEDONE\s+-/);
  assert.match(out, /Not running \(2\), kept so a restart gets its name back: DEADGHOST \(bridge exited\), ENDEDONE \(ended 2026-10-25 14:03 UTC\)/);
  assert.match(out, /cannot send or receive messages/);

  // Read only: the registry file is exactly as it was.
  assert.equal(fs.readFileSync(registryFile, 'utf8'), before);

  // --connected filters to live relay connections only.
  const connectedOut = runStatus(root, `ws://127.0.0.1:${port}`, ['--connected']);
  assert.match(connectedOut, /CONNONE/);
  assert.doesNotMatch(connectedOut, /ALIVEONE/);
  assert.doesNotMatch(connectedOut, /Not running/);

  // Server unreachable: table still renders, relay state marked unknown.
  const offline = runStatus(root, 'ws://127.0.0.1:1');
  assert.match(offline, /relay server unreachable/);
  assert.match(offline, /ALIVEONE\s+\d+\s+alive\s+unknown/);
});
