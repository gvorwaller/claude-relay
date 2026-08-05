const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('/Users/gaylonvorwaller/claude-relay/node_modules/ws');

function waitForMessage(ws, predicate, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeout);
    const handler = data => {
      const message = JSON.parse(data);
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off('message', handler);
      resolve(message);
    };
    ws.on('message', handler);
  });
}

function nextMessage(ws, type) {
  return waitForMessage(ws, message => message.type === type);
}

async function open(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

async function connect(port, clientId, meta) {
  const ws = await open(port);
  const registered = waitForMessage(ws, message => message.type === 'registered');
  ws.send(JSON.stringify({ type: 'register', clientId, ...(meta ? { meta } : {}) }));
  await registered;
  return ws;
}

function startServer(t, root, extraEnv = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), String(port)], {
    env: {
      ...process.env,
      NODE_PATH: '/Users/gaylonvorwaller/claude-relay/node_modules',
      RELAY_MESSAGE_DIR: path.join(root, 'messages'),
      RELAY_LOG_DIR: path.join(root, 'logs'),
      ...extraEnv
    },
    stdio: 'ignore'
  });
  t.after(() => child.kill('SIGTERM'));
  return port;
}

async function connectWithRetry(port, clientId, meta) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await connect(port, clientId, meta);
    } catch {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  throw new Error('relay server did not start');
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '']);
  const pid = child.pid;
  await new Promise(resolve => child.once('exit', resolve));
  return pid;
}

test('orphaned label (dead pid, socket still open) is reassigned to a newcomer', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pid-'));
  const port = startServer(t, root);

  const stalePid = await deadPid();
  const holder = await connectWithRetry(port, 'ORPH', { pid: stalePid });
  // Arm the close listener BEFORE the contest: the server terminates the
  // stale holder while the newcomer's registration is still in flight.
  const holderClosed = new Promise(resolve => holder.once('close', resolve));
  const newcomer = await connect(port, 'ORPH', { pid: process.pid });
  t.after(() => [holder, newcomer].forEach(ws => ws.close()));

  // The stale holder's socket is terminated; the newcomer owns the label.
  await holderClosed;
  const pong = nextMessage(newcomer, 'pong');
  newcomer.send(JSON.stringify({ type: 'ping' }));
  await pong;
});

test('same pid re-registering reseats without rejection', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pid-'));
  const port = startServer(t, root);

  const first = await connectWithRetry(port, 'SEAT', { pid: process.pid });
  const firstClosed = new Promise(resolve => first.once('close', resolve));
  const second = await connect(port, 'SEAT', { pid: process.pid });
  t.after(() => [first, second].forEach(ws => ws.close()));
  await firstClosed;
  const pong = nextMessage(second, 'pong');
  second.send(JSON.stringify({ type: 'ping' }));
  await pong;
});

test('pid-less holder keeps legacy newest-wins takeover (remote/old-client path)', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pid-'));
  const port = startServer(t, root);

  const holder = await connectWithRetry(port, 'LEGACY');
  const displacedNotice = waitForMessage(holder, msg =>
    msg.type === 'error' && /re-registered by a newer connection/.test(msg.message));
  const usurper = await connect(port, 'LEGACY');
  t.after(() => [holder, usurper].forEach(ws => ws.close()));
  await displacedNotice;
});

test('delegate reads and speaks as its base label without ever owning it', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pid-'));
  const port = startServer(t, root);

  const base = await connectWithRetry(port, 'CODEXD', { pid: process.pid });
  const sender = await connect(port, 'A', { pid: process.pid });
  t.after(() => [base, sender].forEach(ws => ws.close()));

  const baseGotFirst = nextMessage(base, 'message');
  sender.send(JSON.stringify({ type: 'message', to: 'CODEXD', content: 'before delegate' }));
  await baseGotFirst;

  // Delegate registers: derived visible ID, no contest with the base.
  const delegate = await open(port);
  t.after(() => delegate.close());
  const delegateRegistered = waitForMessage(delegate, msg => msg.type === 'registered');
  delegate.send(JSON.stringify({
    type: 'register',
    clientId: 'CODEXD',
    delegate: true,
    meta: { pid: 424242 }
  }));
  const registration = await delegateRegistered;
  const delegateId = registration.clientId;
  // Server-minted nonce suffix — never client-supplied text.
  assert.match(delegateId, /^CODEXD~wake-[0-9a-f]{8}$/);
  assert.equal(registration.delegateOf, 'CODEXD');

  // It reads with the base's visibility.
  const history = nextMessage(delegate, 'history');
  delegate.send(JSON.stringify({ type: 'get_history', count: 10 }));
  assert.deepEqual((await history).messages.map(m => m.content), ['before delegate']);

  // Its sends are stored and delivered as the base label.
  const senderGot = nextMessage(sender, 'message');
  delegate.send(JSON.stringify({ type: 'message', to: 'A', content: 'reply via delegate' }));
  const relayed = await senderGot;
  assert.equal(relayed.from, 'CODEXD');

  // Direct mail to the base now reaches base AND delegate; base is untouched.
  const baseGotSecond = nextMessage(base, 'message');
  const delegateGotSecond = nextMessage(delegate, 'message');
  const ack = nextMessage(sender, 'sent');
  sender.send(JSON.stringify({ type: 'message', to: 'CODEXD', content: 'both should hear this' }));
  assert.equal((await baseGotSecond).content, 'both should hear this');
  assert.equal((await delegateGotSecond).content, 'both should hear this');
  assert.equal((await ack).delivered, true);

  // Delegate exit does not disturb the base label.
  const delegateLeft = waitForMessage(sender, msg =>
    msg.type === 'peer_left' && msg.clientId === delegateId);
  delegate.close();
  await delegateLeft;
  const baseGotThird = nextMessage(base, 'message');
  sender.send(JSON.stringify({ type: 'message', to: 'CODEXD', content: 'still owned' }));
  assert.equal((await baseGotThird).content, 'still owned');
});

test('bridge spawned under codex exec self-selects delegate mode (ancestry fallback)', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pid-'));
  const port = startServer(t, root);

  const observer = await connectWithRetry(port, 'A', { pid: process.pid });
  t.after(() => observer.close());

  // Fake `codex` whose argv looks like a headless run; it launches the bridge
  // as a child (no exec, so the parent's args stay "codex exec resume ...").
  const fakeCodex = path.join(root, 'codex');
  fs.writeFileSync(fakeCodex, [
    '#!/bin/bash',
    `node ${JSON.stringify(path.join(__dirname, '..', 'mcp-server.js'))} "--relay-url=ws://127.0.0.1:${port}"`,
    ''
  ].join('\n'), { mode: 0o755 });

  const joined = waitForMessage(observer, msg =>
    msg.type === 'peer_joined' && /^CODEXW~wake-[0-9a-f]{8}$/.test(msg.clientId), 10000);
  const wrapper = spawn(fakeCodex, ['exec', 'resume', 'fake-session-id'], {
    env: {
      ...process.env,
      HOME: root,
      CLAUDE_RELAY_SESSION_ID: '',
      RELAY_DELEGATE_FOR: '',
      RELAY_CLIENT_ID: 'CODEXW'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => wrapper.kill('SIGTERM'));
  wrapper.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  await joined;
});

function writeRegistry(root, entries) {
  const dir = path.join(root, 'claude-relay', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify(entries, null, 2));
}

function spawnBridge(t, root, port, projDir, extraEnv = {}) {
  const mcp = spawn(process.execPath, [path.join(__dirname, '..', 'mcp-server.js'),
    `--relay-url=ws://127.0.0.1:${port}`], {
    cwd: projDir,
    env: {
      ...process.env,
      HOME: root,
      CLAUDE_RELAY_SESSION_ID: '',
      RELAY_DELEGATE_FOR: '',
      RELAY_CLIENT_ID: '',
      ...extraEnv
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => mcp.kill('SIGTERM'));
  // The bridge connects to the relay only on MCP initialize.
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  return mcp;
}

test('restart auto-reclaims a registry label whose recorded pid is dead', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-reclaim-')));
  const port = startServer(t, root);
  const projDir = path.join(root, 'proj');
  fs.mkdirSync(projDir);

  const observer = await connectWithRetry(port, 'A', { pid: process.pid });
  t.after(() => observer.close());

  writeRegistry(root, {
    CODEXR3: { pid: await deadPid(), cwd: projDir, source: 'rename' }
  });

  const joined = waitForMessage(observer, msg =>
    msg.type === 'peer_joined' && msg.clientId === 'CODEXR3', 10000);
  spawnBridge(t, root, port, projDir, { RELAY_CLIENT_ID: 'CODEXR' });
  await joined;
});

test('a registry label whose pid is alive is skipped, not fought over', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-reclaim-')));
  const port = startServer(t, root);
  const projDir = path.join(root, 'proj');
  fs.mkdirSync(projDir);

  const observer = await connectWithRetry(port, 'A', { pid: process.pid });
  t.after(() => observer.close());

  const occupant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  t.after(() => occupant.kill('SIGKILL'));
  writeRegistry(root, {
    CODEXR3: { pid: occupant.pid, cwd: projDir, source: 'rename' }
  });

  // CODEXR3's owner is alive -> the new session must not claim it; with no
  // bare-base registry entry it falls through to plain CODEXR.
  const joined = waitForMessage(observer, msg =>
    msg.type === 'peer_joined' && msg.clientId === 'CODEXR', 10000);
  spawnBridge(t, root, port, projDir, { RELAY_CLIENT_ID: 'CODEXR' });
  await joined;
});

test('clean exit keeps the label->cwd mapping (marked ended) for later reclaim', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-reclaim-')));
  const port = startServer(t, root);
  const projDir = path.join(root, 'proj');
  fs.mkdirSync(projDir);

  const observer = await connectWithRetry(port, 'A', { pid: process.pid });
  t.after(() => observer.close());

  const joined = waitForMessage(observer, msg =>
    msg.type === 'peer_joined' && msg.clientId === 'KEEPME', 10000);
  const mcp = spawnBridge(t, root, port, projDir, { CLAUDE_RELAY_SESSION_ID: 'KEEPME' });
  await joined;

  const exited = new Promise(resolve => mcp.once('exit', resolve));
  mcp.kill('SIGTERM');
  await exited;

  const registry = JSON.parse(
    fs.readFileSync(path.join(root, 'claude-relay', 'sessions', 'registry.json'), 'utf8'));
  assert.ok(registry.KEEPME, 'mapping survives clean exit');
  assert.ok(registry.KEEPME.ended, 'entry is marked ended');
  assert.equal(registry.KEEPME.cwd, projDir);
});

test('MCP bridge in RELAY_DELEGATE_FOR mode registers as a transparent delegate', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pid-'));
  const port = startServer(t, root);

  const observer = await connectWithRetry(port, 'A', { pid: process.pid });
  t.after(() => observer.close());

  const joined = waitForMessage(observer, msg =>
    msg.type === 'peer_joined' && /^CODEXD~wake-[0-9a-f]{8}$/.test(msg.clientId), 10000);
  const mcp = spawn(process.execPath, [path.join(__dirname, '..', 'mcp-server.js'),
    `--relay-url=ws://127.0.0.1:${port}`], {
    env: {
      ...process.env,
      HOME: root,
      CLAUDE_RELAY_SESSION_ID: '',
      RELAY_CLIENT_ID: '',
      RELAY_DELEGATE_FOR: 'CODEXD'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => mcp.kill('SIGTERM'));
  let stdoutBuffer = '';
  const waiting = [];
  mcp.stdout.setEncoding('utf8');
  mcp.stdout.on('data', chunk => {
    stdoutBuffer += chunk;
    let newline;
    while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      const value = JSON.parse(line);
      const match = waiting.find(entry => entry.predicate(value));
      if (match) {
        waiting.splice(waiting.indexOf(match), 1);
        match.resolve(value);
      }
    }
  });
  const next = predicate => new Promise(resolve => waiting.push({ predicate, resolve }));
  const send = value => mcp.stdin.write(`${JSON.stringify(value)}\n`);

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await next(msg => msg.id === 1);
  await joined;

  // Status is transparent about the delegate relationship.
  const statusReply = next(msg => msg.id === 2);
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'relay_status', arguments: {} } });
  const status = (await statusReply).result.content[0].text;
  assert.match(status, /CODEXD~wake-[0-9a-f]{8}/);
  assert.match(status, /delegate of CODEXD/);

  // Its relay_send arrives at the peer as the base label.
  const got = nextMessage(observer, 'message');
  const sendReply = next(msg => msg.id === 3);
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
    name: 'relay_send', arguments: { to: 'A', message: 'delegate speaking' }
  }});
  await sendReply;
  assert.equal((await got).from, 'CODEXD');

  // Delegates never write the label->pid registry.
  const registryFile = path.join(root, 'claude-relay', 'sessions', 'registry.json');
  if (fs.existsSync(registryFile)) {
    const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    assert.deepEqual(Object.keys(registry).filter(id => id.includes('CODEXD')), []);
  }
});

test('identity mode cannot be switched on a live socket (primary<->delegate)', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pid-'));
  const port = startServer(t, root);

  // Primary -> delegate: rejected.
  const primary = await connectWithRetry(port, 'MODEA', { pid: process.pid });
  t.after(() => primary.close());
  const primaryRefused = waitForMessage(primary, msg =>
    msg.type === 'error' && /delegate registration requires a fresh connection/.test(msg.message));
  primary.send(JSON.stringify({ type: 'register', clientId: 'MODEA', delegate: true, meta: { pid: 111 } }));
  await primaryRefused;

  // Delegate -> primary: rejected.
  const delegate = await open(port);
  t.after(() => delegate.close());
  const delegateRegistered = waitForMessage(delegate, msg => msg.type === 'registered');
  delegate.send(JSON.stringify({ type: 'register', clientId: 'MODEB', delegate: true, meta: { pid: 222 } }));
  await delegateRegistered;
  const delegateRefused = waitForMessage(delegate, msg =>
    msg.type === 'error' && /primary registration requires a fresh connection/.test(msg.message));
  delegate.send(JSON.stringify({ type: 'register', clientId: 'MODEB', meta: { pid: 222 } }));
  await delegateRefused;
});

test('hostile client IDs and message targets are refused at the boundary', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-grammar-'));
  const port = startServer(t, root);

  const good = await connectWithRetry(port, 'GRAMOK', { pid: process.pid });
  t.after(() => good.close());

  // Registration: shell/AppleScript metacharacters, path traversal, spaces,
  // and the reserved delegate separator are all rejected.
  const hostileIds = [
    'CODEX3"; do shell script "touch /tmp/pwned"; --',
    'CODEX$(whoami)',
    'CODEX`id`',
    '../../etc/passwd',
    'CODEX 3',
    'CODEX3~wake-1',
    '',
    'x'.repeat(65)
  ];
  for (const hostile of hostileIds) {
    const ws = await open(port);
    const refused = waitForMessage(ws, msg => msg.type === 'error' && /Invalid client ID/.test(msg.message));
    ws.send(JSON.stringify({ type: 'register', clientId: hostile, meta: { pid: process.pid } }));
    await refused;
    ws.close();
  }

  // Message targets: same grammar, refused before reaching notify hooks.
  const refusedTarget = waitForMessage(good, msg =>
    msg.type === 'error' && /Invalid message target/.test(msg.message));
  good.send(JSON.stringify({
    type: 'message',
    to: 'CODEX3"; do shell script "touch /tmp/pwned"; --',
    content: 'injection attempt'
  }));
  await refusedTarget;

  // Watch targets too.
  const refusedWatch = waitForMessage(good, msg =>
    msg.type === 'error' && /Watch target must be a valid client ID/.test(msg.message));
  good.send(JSON.stringify({ type: 'watch', for: 'CODEX$(id)' }));
  await refusedWatch;

  // A live server-minted delegate ID stays addressable despite containing '~'.
  const delegate = await open(port);
  t.after(() => delegate.close());
  const delegateReg = waitForMessage(delegate, msg => msg.type === 'registered');
  delegate.send(JSON.stringify({ type: 'register', clientId: 'GRAMOK', delegate: true, meta: { pid: 9911 } }));
  const delegateId = (await delegateReg).clientId;
  const delegateGot = waitForMessage(delegate, msg => msg.type === 'message');
  good.send(JSON.stringify({ type: 'message', to: delegateId, content: 'direct to delegate' }));
  assert.equal((await delegateGot).content, 'direct to delegate');
});

test('a delegate connection is immutable: no re-registration under another base', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pid-')));
  const port = startServer(t, root);

  // Wait for the server to be listening before opening a raw socket.
  const observer = await connectWithRetry(port, 'OBS', { pid: process.pid });
  t.after(() => observer.close());

  const delegate = await open(port);
  t.after(() => delegate.close());
  const registered = waitForMessage(delegate, msg => msg.type === 'registered');
  delegate.send(JSON.stringify({ type: 'register', clientId: 'IMMUT', delegate: true, meta: { pid: 4242 } }));
  const firstId = (await registered).clientId;

  const refused = waitForMessage(delegate, msg =>
    msg.type === 'error' && /delegates are immutable/.test(msg.message));
  delegate.send(JSON.stringify({ type: 'register', clientId: 'OTHERBASE', delegate: true, meta: { pid: 4242 } }));
  await refused;

  // The original delegate identity is untouched and still the only mapping.
  const peersMsg = waitForMessage(observer, msg => msg.type === 'peers');
  observer.send(JSON.stringify({ type: 'get_peers' }));
  const peerList = (await peersMsg).peers;
  assert.ok(peerList.includes(firstId));
  assert.equal(peerList.some(id => id.startsWith('OTHERBASE')), false);
});
