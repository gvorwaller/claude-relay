const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

// A bridge whose label would be a fresh auto-numbered one (the ChatGPT app's
// tool-list bridges) joins the relay only on its first relay call or after
// staying up past LAZY_JOIN_MS (15s); until then it leaves nothing behind.

// A stuck test fails instead of hanging the run.
const LIMIT = { timeout: 60000 };

function startServer(t, root) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), String(port)], {
    env: {
      ...process.env,
      RELAY_MESSAGE_DIR: path.join(root, 'messages'),
      RELAY_LOG_DIR: path.join(root, 'logs'),
      RELAY_DISABLE_NOTIFICATIONS: '1'
    },
    stdio: 'ignore'
  });
  t.after(() => child.kill('SIGTERM'));
  return port;
}

async function observe(t, port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      const registered = new Promise(resolve => ws.on('message', data => {
        if (JSON.parse(data).type === 'registered') resolve();
      }));
      ws.send(JSON.stringify({ type: 'register', clientId: 'OBSERVER', meta: { pid: process.pid } }));
      await registered;
      const joins = [];
      ws.on('message', data => {
        const message = JSON.parse(data);
        if (message.type === 'peer_joined') joins.push(message.clientId);
      });
      t.after(() => ws.close());
      return joins;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  throw new Error('relay server did not start');
}

// PROBE is registered for another folder, so a bridge configured as PROBE
// in this one resolves to a fresh numbered label (PROBE2), as Codex Desktop's
// fixed "CODEX" does.
function setup(t) {
  // No folder removal here: after-hooks run in order and a throwing one
  // skips the rest, which would leave the relay and bridges running.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-lazy-')));
  const project = path.join(root, 'proj');
  fs.mkdirSync(project);
  const sessions = path.join(root, 'claude-relay', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 'registry.json'), JSON.stringify({
    PROBE: { cwd: path.join(root, 'elsewhere'), source: 'RELAY_CLIENT_ID', ended: new Date().toISOString() }
  }));
  return { root, project, sessions, port: startServer(t, root) };
}

function bridge(t, { root, project, port }) {
  const mcp = spawn(process.execPath, [path.join(__dirname, '..', 'mcp-server.js'),
    `--relay-url=ws://127.0.0.1:${port}`], {
    cwd: project,
    env: { ...process.env, HOME: root, CLAUDE_RELAY_SESSION_ID: '', RELAY_DELEGATE_FOR: '', RELAY_CLIENT_ID: 'PROBE' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => mcp.kill('SIGTERM'));
  const answers = new Map();
  let out = '';
  mcp.stdout.setEncoding('utf8');
  mcp.stdout.on('data', chunk => {
    out += chunk;
    let newline;
    while ((newline = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, newline);
      out = out.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        if (answers.has(message.id)) answers.get(message.id)(message);
      } catch {}
    }
  });
  const request = (id, method, params = {}) => new Promise(resolve => {
    answers.set(id, resolve);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return {
    mcp,
    request,
    status: async id => (await request(id, 'tools/call', { name: 'relay_status', arguments: {} }))
      .result.content[0].text,
    end: async () => {
      const exited = new Promise(resolve => mcp.once('exit', resolve));
      mcp.kill('SIGTERM');
      await exited;
    }
  };
}

function registry(sessions) {
  return JSON.parse(fs.readFileSync(path.join(sessions, 'registry.json'), 'utf8'));
}

test('a tool-list check that quits within the delay leaves no label, enrollment or registry entry', LIMIT, async t => {
  const env = setup(t);
  const joins = await observe(t, env.port);
  const probe = bridge(t, env);
  await probe.request(1, 'initialize');
  const tools = await probe.request(2, 'tools/list');
  assert.ok(tools.result.tools.some(tool => tool.name === 'relay_send'));
  await new Promise(resolve => setTimeout(resolve, 1000));
  await probe.end();
  await new Promise(resolve => setTimeout(resolve, 200));

  assert.deepEqual(joins, []);
  assert.deepEqual(Object.keys(registry(env.sessions)), ['PROBE']);
  assert.ok(!fs.existsSync(path.join(env.sessions, 'owners', 'PROBE2.secret')));
  const owners = path.join(env.root, 'owners.json');
  if (fs.existsSync(owners)) assert.doesNotMatch(fs.readFileSync(owners, 'utf8'), /PROBE2/);
});

test('the first relay call joins, waits for the join, and is answered as the joined label', LIMIT, async t => {
  const env = setup(t);
  const joins = await observe(t, env.port);
  const session = bridge(t, env);
  await session.request(1, 'initialize');
  const asked = Date.now();
  assert.match(await session.status(2), /^Connected to .* as "PROBE2"/);
  assert.ok(Date.now() - asked < 5000, 'answered as soon as the join lands, not at the 10s backstop');
  assert.deepEqual(joins, ['PROBE2']);
  assert.ok(registry(env.sessions).PROBE2);
});

test('a bridge that stays up past the delay joins on its own', LIMIT, async t => {
  const env = setup(t);
  const joins = await observe(t, env.port);
  const session = bridge(t, env);
  await session.request(1, 'initialize');
  await new Promise(resolve => setTimeout(resolve, 5000));
  assert.deepEqual(joins, [], 'not yet');
  const deadline = Date.now() + 20000;
  while (!joins.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(joins, ['PROBE2']);
});

test('two fresh sessions that resolved the same number both join, the second as the next number', LIMIT, async t => {
  const env = setup(t);
  const joins = await observe(t, env.port);
  const first = bridge(t, env);
  const second = bridge(t, env);
  await first.request(1, 'initialize');
  await second.request(1, 'initialize');
  assert.match(await first.status(2), /as "PROBE2"/);
  assert.match(await second.status(2), /as "PROBE3"/);
  assert.deepEqual(joins, ['PROBE2', 'PROBE3']);
});
