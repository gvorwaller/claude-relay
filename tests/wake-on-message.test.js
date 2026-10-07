const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

test('Claude Stop hook honors an explicit existing Node executable', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'relay-stop-hook.sh'),
    'utf8'
  );
  assert.match(source, /NODE_BIN="\$\{RELAY_NODE_BIN:-node\}"/);
  assert.match(source, /"\$NODE_BIN" -e 'console\.log\(new Date\(\)\.toISOString\(\)\)'/);
  assert.match(source, /"\$NODE_BIN" "\$WATCH" --for "\$ID"/);
});

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

test('unknown watch cursor logs and wakes once for retained gap mail', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-watch-unknown-'));
  const port = startServer(t, root);
  const sender = await connectWithRetry(port, 'A');
  t.after(() => sender.close());
  const ack = nextMessage(sender, 'sent');
  sender.send(JSON.stringify({ type: 'message', to: 'C', content: 'mail in gap' }));
  await ack;

  const watcher = await connect(port, 'C-watch-unknown');
  t.after(() => watcher.close());
  const recovery = nextMessage(watcher, 'watch_unknown_cursor');
  let notices = 0;
  watcher.on('message', data => {
    if (JSON.parse(data).type === 'watch_unknown_cursor') notices += 1;
  });
  watcher.send(JSON.stringify({ type: 'watch', for: 'C', since: 'pruned-message-id' }));
  assert.deepEqual(await recovery, {
    type: 'watch_unknown_cursor', for: 'C', retainedMail: true
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(notices, 1);
  const logFiles = fs.readdirSync(path.join(root, 'logs'));
  assert.ok(logFiles.some(file => fs.readFileSync(path.join(root, 'logs', file), 'utf8')
    .includes('watch_unknown_cursor')));

  const repeated = nextMessage(watcher, 'watch_unknown_cursor');
  watcher.send(JSON.stringify({ type: 'watch', for: 'C', since: 'pruned-message-id' }));
  assert.equal((await repeated).retainedMail, false, 'unchanged stale cursor does not wake again');

  watcher.close();
  const nextAck = nextMessage(sender, 'sent');
  sender.send(JSON.stringify({ type: 'message', to: 'C', content: 'new gap mail' }));
  await nextAck;
  const rearmed = await connect(port, 'C-watch-rearmed');
  t.after(() => rearmed.close());
  const newRecovery = nextMessage(rearmed, 'watch_unknown_cursor');
  rearmed.send(JSON.stringify({ type: 'watch', for: 'C', since: 'pruned-message-id' }));
  assert.equal((await newRecovery).retainedMail, true, 'new mail permits one more recovery wake');

  // A valid cursor past the gap mail does not cause another recovery wake.
  const latest = nextMessage(sender, 'history');
  sender.send(JSON.stringify({ type: 'get_history', count: 1 }));
  const cursor = (await latest).cursor;
  const watching = nextMessage(rearmed, 'watching');
  rearmed.send(JSON.stringify({ type: 'watch', for: 'C', since: cursor }));
  await watching;
  await assert.rejects(waitForMessage(rearmed, m =>
    m.type === 'watch_unknown_cursor' || m.type === 'new_message', 300), /Timed out/);
});

test('relay-watch helper reports unknown cursor so the caller can resync', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-watch-helper-'));
  const port = startServer(t, root);
  const sender = await connectWithRetry(port, 'A');
  t.after(() => sender.close());
  const ack = nextMessage(sender, 'sent');
  sender.send(JSON.stringify({ type: 'message', to: 'C', content: 'mail in gap' }));
  await ack;
  const helper = spawn(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'relay-watch.js'), '--for', 'C',
    '--since', 'pruned-message-id', '--timeout', '2',
    '--relay-url', `ws://127.0.0.1:${port}`
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => helper.kill('SIGTERM'));
  let output = '';
  helper.stdout.on('data', chunk => { output += chunk; });
  const code = await new Promise(resolve => helper.once('close', resolve));
  assert.equal(code, 0);
  assert.equal(output.trim(), 'unknown-cursor');
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

// td-98eecf #2: the Stop hook resolved its label once and re-armed it forever,
// so after relay_rename a listener kept watching the abandoned label while
// the next Stop armed a second one. A fake "claude" process owns a fake
// bridge (the registry pid) and runs the hook as its child on demand.
function stopHookHarness(t, port, extraEnv = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-stop-hook-')));
  const scripts = path.join(root, 'claude-relay', 'scripts');
  const sessions = path.join(root, 'claude-relay', 'sessions');
  const tmp = path.join(root, 'tmp');
  for (const dir of [scripts, sessions, tmp]) fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(path.join(__dirname, '..', 'scripts', 'relay-watch.js'), path.join(scripts, 'relay-watch.js'));
  const hook = path.join(__dirname, '..', 'scripts', 'relay-stop-hook.sh');
  const claude = spawn('/bin/bash', ['-c', `
    sleep 600 & echo $! > "$D/bridge.pid"
    n=0
    while :; do
      if [ -f "$D/go" ]; then
        rm -f "$D/go"; n=$((n+1))
        ( /bin/bash \${HOOK_TRACE:-} "$HOOK" 2> "$D/hook$n.err"; echo $? > "$D/hook$n.code" ) &
      fi
      sleep 0.05
    done`], {
    env: {
      ...process.env, D: root, HOOK: hook, HOME: root, TMPDIR: tmp,
      RELAY_URL: `ws://127.0.0.1:${port}`, RELAY_NODE_BIN: process.execPath, ...extraEnv
    },
    stdio: 'ignore',
    detached: true
  });
  t.after(() => { try { process.kill(-claude.pid, 'SIGKILL'); } catch {} });
  const until = async (predicate, timeout = 8000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Timed out waiting for stop-hook state');
  };
  const read = file => { try { return fs.readFileSync(path.join(root, file), 'utf8').trim(); } catch { return null; } };
  const lock = path.join(tmp, `claude-relay-stop-hook-session-${claude.pid}.lock`, 'owner');
  return {
    root, tmp, claude, read, until,
    owner: () => { try { return fs.readFileSync(lock, 'utf8').trim().split(' '); } catch { return null; } },
    lockExists: () => fs.existsSync(path.dirname(lock)),
    register: label => fs.writeFileSync(path.join(sessions, 'registry.json'),
      JSON.stringify({ [label]: { pid: Number(read('bridge.pid')), cwd: root } })),
    stop: () => fs.writeFileSync(path.join(root, 'go'), '')
  };
}

function alive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

test('Stop hook keeps one listener per session and follows a rename', async t => {
  const relayRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wake-'));
  const port = startServer(t, relayRoot);
  const peer = await connectWithRetry(port, 'PEER');
  t.after(() => peer.close());
  const h = stopHookHarness(t, port);
  await h.until(() => h.read('bridge.pid'));

  // A listener from the per-label version, owned by this same session.
  const legacy = spawn('/bin/bash', ['-c', 'exec -a relay-stop-hook-legacy sleep 600'], { stdio: 'ignore' });
  t.after(() => legacy.kill('SIGKILL'));
  const legacyLock = path.join(h.tmp, 'claude-relay-stop-hook-OLDL.lock');
  fs.mkdirSync(legacyLock);
  fs.writeFileSync(path.join(legacyLock, 'owner'), `${legacy.pid} ${h.claude.pid} legacy-token\n`);

  h.register('OLDL');
  h.stop();
  const [firstHook, , , firstLabel] = await h.until(() => h.owner()?.[3] === 'OLDL' && h.owner());
  assert.equal(firstLabel, 'OLDL');
  await h.until(() => !alive(legacy.pid));
  assert.equal(fs.existsSync(legacyLock), false, 'legacy per-label lock reaped');

  // A repeated Stop for the same label is a no-op.
  h.stop();
  assert.equal(await h.until(() => h.read('hook2.code')), '0');
  assert.equal(h.owner()[0], firstHook);

  // relay_rename: the next Stop takes the session's listener over.
  h.register('NEWL');
  h.stop();
  await h.until(() => h.owner()?.[3] === 'NEWL');
  await h.until(() => !alive(firstHook));
  const [secondHook] = h.owner();
  assert.notEqual(secondHook, firstHook);

  // Without a saved cursor the listener arms from "now": wait until its
  // watcher is subscribed before sending.
  await h.until(async () => {
    const sessions = waitForMessage(peer, msg => msg.type === 'sessions');
    peer.send(JSON.stringify({ type: 'get_sessions' }));
    return Object.keys((await sessions).sessions).some(id => id.startsWith('NEWL-watch-'));
  });
  peer.send(JSON.stringify({ type: 'message', to: 'NEWL', content: 'for the new label' }));
  assert.equal(await h.until(() => h.read('hook3.code')), '2');
  assert.match(h.read('hook3.err'), /Relay mail is waiting for NEWL/);
  await h.until(() => !h.lockExists());
});

test('a running Stop hook stands down when its session is renamed', async t => {
  const relayRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wake-'));
  const port = startServer(t, relayRoot);
  const h = stopHookHarness(t, port, { RELAY_STOP_HOOK_WATCH_TIMEOUT: '1' });
  await h.until(() => h.read('bridge.pid'));
  h.register('OLDL');
  h.stop();
  await h.until(() => h.owner()?.[3] === 'OLDL');
  // Let it get past its first pass and into 1s watch re-arms.
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(h.read('hook1.code'), null, 'still listening for OLDL');
  h.register('NEWL');
  assert.equal(await h.until(() => h.read('hook1.code')), '0');
  assert.equal(h.lockExists(), false, 'lock released for the next Stop');
});
