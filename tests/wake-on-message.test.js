const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

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

async function connect(port, clientId) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const registered = waitForMessage(ws, message => message.type === 'registered');
  ws.send(JSON.stringify({ type: 'register', clientId }));
  await registered;
  return ws;
}

function startServer(t, root, extraEnv = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), String(port)], {
    env: {
      ...process.env,
      NODE_PATH: path.join(__dirname, '..', 'node_modules'),
      RELAY_MESSAGE_DIR: path.join(root, 'messages'),
      RELAY_LOG_DIR: path.join(root, 'logs'),
      ...extraEnv
    },
    stdio: 'ignore'
  });
  t.after(() => child.kill('SIGTERM'));
  return port;
}

async function connectWithRetry(port, clientId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return await connect(port, clientId);
    } catch {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  throw new Error('server never became reachable');
}

test('sends are acked honestly: delivered live vs durably queued', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wake-'));
  const port = startServer(t, root);
  const sender = await connectWithRetry(port, 'A');
  t.after(() => sender.close());

  // Offline target: stored + acked as queued, and NOT an error.
  const errors = [];
  sender.on('message', data => {
    const message = JSON.parse(data);
    if (message.type === 'error') errors.push(message);
  });
  const queuedAck = nextMessage(sender, 'sent');
  sender.send(JSON.stringify({ type: 'message', to: 'GHOST', content: 'hello?' }));
  const queued = await queuedAck;
  assert.equal(queued.to, 'GHOST');
  assert.equal(queued.delivered, false);
  assert.ok(queued.id, 'ack carries the stored message id');
  assert.equal(errors.length, 0, 'queued mail must not be reported as an error');

  // The queued message really is replayed when the target appears.
  const ghost = await connect(port, 'GHOST');
  t.after(() => ghost.close());
  ghost.send(JSON.stringify({ type: 'get_history', count: 10 }));
  const replay = await nextMessage(ghost, 'history');
  assert.deepEqual(replay.messages.map(m => m.content), ['hello?']);

  // Online target: acked as delivered.
  const liveAck = nextMessage(sender, 'sent');
  const received = nextMessage(ghost, 'message');
  sender.send(JSON.stringify({ type: 'message', to: 'GHOST', content: 'now live' }));
  assert.equal((await liveAck).delivered, true);
  assert.equal((await received).content, 'now live');
});

test('watch with since backfills a ping for mail that arrived while deaf', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wake-'));
  const port = startServer(t, root);
  const sender = await connectWithRetry(port, 'A');
  t.after(() => sender.close());

  const beforeMail = new Date(Date.now() - 1000).toISOString();
  const ack = nextMessage(sender, 'sent');
  sender.send(JSON.stringify({ type: 'message', to: 'C', content: 'gap mail' }));
  await ack;

  // Watcher arms AFTER the mail landed — with since it gets pinged instantly.
  const watcher = await connect(port, 'C-watch-1');
  t.after(() => watcher.close());
  const backfill = nextMessage(watcher, 'new_message');
  watcher.send(JSON.stringify({ type: 'watch', for: 'C', since: beforeMail }));
  const ping = await backfill;
  assert.equal(ping.for, 'C');
  assert.equal(ping.pending, 1);

  // A since cursor AFTER the mail stays silent (no stale re-ping)...
  const lateWatcher = await connect(port, 'C-watch-2');
  t.after(() => lateWatcher.close());
  const watching = nextMessage(lateWatcher, 'watching');
  lateWatcher.send(JSON.stringify({ type: 'watch', for: 'C', since: new Date().toISOString() }));
  await watching;
  await assert.rejects(
    waitForMessage(lateWatcher, m => m.type === 'new_message', 400),
    /Timed out/,
    'no backfill ping when nothing arrived after since'
  );

  // ...but live pings still flow to it.
  const livePing = nextMessage(lateWatcher, 'new_message');
  sender.send(JSON.stringify({ type: 'message', to: 'C', content: 'fresh mail' }));
  assert.equal((await livePing).for, 'C');

  // The target's own outbound mail never triggers its watchers.
  const target = await connect(port, 'C');
  t.after(() => target.close());
  const selfWatcher = await connect(port, 'C-watch-3');
  t.after(() => selfWatcher.close());
  const selfWatching = nextMessage(selfWatcher, 'watching');
  selfWatcher.send(JSON.stringify({ type: 'watch', for: 'C' }));
  await selfWatching;
  target.send(JSON.stringify({ type: 'message', to: 'all', content: 'my own broadcast' }));
  await assert.rejects(
    waitForMessage(selfWatcher, m => m.type === 'new_message', 400),
    /Timed out/,
    'an agent must not be woken by its own broadcast'
  );
});

test('relay-watch-loop.sh exits new-message when mail arrives', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wake-'));
  const port = startServer(t, root);
  const sender = await connectWithRetry(port, 'A');
  t.after(() => sender.close());

  const loopJoined = waitForMessage(sender, message =>
    message.type === 'peer_joined' && message.clientId.startsWith('D-watch-'));
  const loop = spawn('bash', [
    path.join(__dirname, '..', 'scripts', 'relay-watch-loop.sh'),
    '--for', 'D', '--watch-timeout', '5', '--max-minutes', '1',
    '--relay-url', `ws://127.0.0.1:${port}`
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => loop.kill('SIGTERM'));
  const loopOutput = new Promise((resolve, reject) => {
    let stdout = '';
    loop.stdout.on('data', chunk => { stdout += chunk; });
    loop.once('error', reject);
    loop.once('exit', code => resolve({ code, stdout: stdout.trim() }));
  });

  await loopJoined;
  await new Promise(resolve => setTimeout(resolve, 10));
  sender.send(JSON.stringify({ type: 'message', to: 'D', content: 'wake the loop' }));
  assert.deepEqual(await loopOutput, { code: 0, stdout: 'new-message' });
});

test('server fires exec notify hooks with context env, without touching message flow', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wake-'));
  const markerPath = path.join(root, 'hook-fired');
  const configPath = path.join(root, 'notify.json');
  fs.writeFileSync(configPath, JSON.stringify({
    CODEXTEST: [{
      type: 'exec',
      command: `printf '%s %s %s' "$RELAY_FOR" "$RELAY_FROM" "$RELAY_DELIVERED" > "${markerPath}"`
    }]
  }));
  const port = startServer(t, root, { RELAY_NOTIFY_CONFIG: configPath });
  const sender = await connectWithRetry(port, 'A');
  t.after(() => sender.close());

  const ack = nextMessage(sender, 'sent');
  sender.send(JSON.stringify({ type: 'message', to: 'CODEXTEST', content: 'wake codex' }));
  assert.equal((await ack).delivered, false);

  let marker = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      marker = fs.readFileSync(markerPath, 'utf8');
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  assert.equal(marker, 'CODEXTEST A 0');
});
