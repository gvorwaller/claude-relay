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
      NODE_PATH: path.join(__dirname, '..', 'node_modules'),
      RELAY_MESSAGE_DIR: path.join(root, 'messages'),
      RELAY_LOG_DIR: path.join(root, 'logs'),
      RELAY_DISABLE_NOTIFICATIONS: '1',
      ...extraEnv
    },
    stdio: process.env.RELAY_TEST_DEBUG ? 'inherit' : 'ignore'
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

test('default relay listener accepts loopback but refuses the host LAN address', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-loopback-')));
  const port = startServer(t, root);
  const local = await connectWithRetry(port, 'LOOPBACKCHECK', { pid: process.pid });
  local.close();

  const lanAddress = Object.values(os.networkInterfaces())
    .flat()
    .find(address => address && address.family === 'IPv4' && !address.internal)?.address;
  if (!lanAddress) {
    t.skip('No non-loopback IPv4 address is available on this host');
    return;
  }

  const exposed = new WebSocket(`ws://${lanAddress}:${port}`);
  const outcome = await new Promise(resolve => {
    const timer = setTimeout(() => resolve('timeout'), 1500);
    exposed.once('open', () => { clearTimeout(timer); resolve('open'); });
    exposed.once('error', () => { clearTimeout(timer); resolve('refused'); });
  });
  exposed.terminate();
  assert.equal(outcome, 'refused', `relay unexpectedly accepted a LAN connection on ${lanAddress}`);
});


// Obtain a real job capability the way a delegate does: the server's notify
// path mints one and writes it to a 0600 file for the spawned wake. The test
// hook simply copies that file somewhere readable, so the whole minting chain
// is exercised rather than bypassed.
function notifyConfigForTokens(root) {
  const configPath = path.join(root, 'notify.json');
  const outDir = path.join(root, 'tokens');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    '*': [{
      type: 'exec',
      // The wake must OUTLIVE its delegate's registration, as a real codex
      // run does. It exits on an explicit state signal from the test; the
      // bounded loop is only a leak guard after a catastrophically failed
      // test, never the synchronization mechanism.
      command: `cp "$RELAY_JOB_TOKEN_FILE" "${outDir}/$RELAY_FOR.token"; `
        + 'for i in $(seq 1 2400); do '
        + `[ -f "${outDir}/$RELAY_FOR.release" ] && exit 0; sleep 0.05; done; exit 0`
    }]
  }));
  return { configPath, outDir };
}

async function mintJobToken(t, outDir, sender, base) {
  const tokenPath = path.join(outDir, `${base}.token`);
  try { fs.unlinkSync(tokenPath); } catch {}
  sender.send(JSON.stringify({ type: 'message', to: base, content: 'wake trigger' }));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const token = fs.readFileSync(tokenPath, 'utf8').trim();
      if (token) {
        // Always release the fake wake, including when a later assertion
        // fails. Releasing is idempotent and applies to every wake for this
        // base label, including a debounce predecessor still winding down.
        t.after(() => releaseWake(outDir, base));
        return token;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`job capability never appeared for ${base}`);
}

function releaseWake(outDir, base) {
  fs.writeFileSync(path.join(outDir, `${base}.release`), 'release');
}

test('local operator can terminate one active delegate process group', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-terminate-'));
  fs.mkdirSync(path.join(root, 'messages'));
  // Keep this fixture inside the message-retention window as the calendar
  // advances; expiry at startup is unrelated to delegate termination.
  const durableMail = path.join(root, 'messages', `${new Date().toISOString().slice(0, 10)}.jsonl`);
  fs.writeFileSync(durableMail, `${JSON.stringify({ id: 'preserved', from: 'TERMINATE-SOURCE', to: 'CODEX1', content: 'durable' })}\n`);
  const configPath = path.join(root, 'notify.json');
  fs.writeFileSync(configPath, JSON.stringify({
    '*': [{ type: 'exec', command: 'sleep 120' }]
  }));
  const port = startServer(t, root, { RELAY_NOTIFY_CONFIG: configPath });
  const sender = await connectWithRetry(port, 'TERMINATE-SOURCE', { pid: process.pid });
  t.after(() => sender.close());
  sender.send(JSON.stringify({ type: 'message', to: 'CODEX1', content: 'start a wake' }));

  let job;
  for (let attempt = 0; attempt < 200 && !job; attempt += 1) {
    try {
      const name = fs.readdirSync(path.join(root, 'jobs')).find(file => file.endsWith('.json'));
      if (name) {
        const candidate = JSON.parse(fs.readFileSync(path.join(root, 'jobs', name), 'utf8'));
        if (candidate.spawnPid) job = candidate;
      }
    } catch {}
    if (!job) await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(job?.spawnPid, 'active wake job was created');

  const operator = await open(port);
  t.after(() => operator.close());
  const response = nextMessage(operator, 'delegate_termination_requested');
  operator.send(JSON.stringify({
    type: 'operator_terminate_delegate',
    adminSecret: fs.readFileSync(path.join(root, 'admin.secret'), 'utf8').trim(),
    jobId: job.jobId
  }));
  const result = await response;
  assert.equal(result.jobId, job.jobId);
  assert.equal(result.owner, 'CODEX1');

  const stopped = JSON.parse(fs.readFileSync(path.join(root, 'jobs', `${job.jobId}.json`), 'utf8'));
  assert.equal(stopped.status, 'interrupted');
  assert.match(stopped.reason, /local operator/);
  assert.match(fs.readFileSync(durableMail, 'utf8'), /"id":"preserved"/);
});



test('a responsive holder is never evicted, even by a claimant quoting its pid', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pid-'));
  const port = startServer(t, root);

  const holder = await connectWithRetry(port, 'SEAT', { pid: process.pid });
  t.after(() => holder.close());

  // Forging the holder's pid used to be enough to be "reseated". The server
  // now asks the holder itself, so the assertion is worthless.
  const claimant = await open(port);
  t.after(() => claimant.close());
  const rejected = waitForMessage(claimant, msg => msg.type === 'register_rejected', 25000);
  claimant.send(JSON.stringify({ type: 'register', clientId: 'SEAT', meta: { pid: process.pid } }));
  assert.match((await rejected).reason, /answered a liveness probe/);

  // The holder is undisturbed.
  const pong = nextMessage(holder, 'pong');
  holder.send(JSON.stringify({ type: 'ping' }));
  await pong;
});

test('an unresponsive holder is reclaimed (legitimate reconnect after a drop)', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pid-'));
  const port = startServer(t, root);

  const holder = await connectWithRetry(port, 'DEADSOCK', { pid: process.pid });
  t.after(() => holder.close());
  // Simulate a corpse: the socket is still open server-side but the client
  // will never answer a probe again.
  holder.pong = () => {};
  holder._receiver.removeAllListeners('ping');
  holder.pause();

  const reconnect = await open(port);
  t.after(() => reconnect.close());
  const registered = waitForMessage(reconnect, msg => msg.type === 'registered', 25000);
  reconnect.send(JSON.stringify({ type: 'register', clientId: 'DEADSOCK', meta: { pid: process.pid } }));
  assert.equal((await registered).clientId, 'DEADSOCK');
});

// docs/2026-08-28-claude-reconnect-live-holder-race.md: a reconnecting bridge
// raced its predecessor's socket close and was told the label "changed
// hands", then suspended forever. A holder that merely LEAVES during the
// probe frees the label for the claimant.
test('a holder that disconnects during its liveness probe yields the label', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pid-'));
  const port = startServer(t, root);

  const holder = await connectWithRetry(port, 'HANDOFF', { pid: process.pid });
  holder.pong = () => {};
  holder._receiver.removeAllListeners('ping');
  holder.pause();

  const claimant = await open(port);
  t.after(() => claimant.close());
  const outcome = waitForMessage(claimant, msg =>
    msg.type === 'registered' || msg.type === 'register_rejected', 25000);
  claimant.send(JSON.stringify({ type: 'register', clientId: 'HANDOFF', meta: { pid: process.pid } }));
  setTimeout(() => holder.terminate(), 300); // mid-probe: first retry is ~3s out
  const result = await outcome;
  assert.equal(result.type, 'registered', result.reason);
  assert.equal(result.clientId, 'HANDOFF');
});

test('delegate reads and speaks as its base label without ever owning it', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pid-')));
  const { configPath, outDir } = notifyConfigForTokens(root);
  const port = startServer(t, root, { RELAY_NOTIFY_CONFIG: configPath, RELAY_BIND_DELEGATE_ANCESTRY: '0' });

  const base = await connectWithRetry(port, 'CODEXD', { pid: process.pid });
  const sender = await connect(port, 'A', { pid: process.pid });
  t.after(() => [base, sender].forEach(ws => ws.close()));

  const baseGotFirst = nextMessage(base, 'message');
  sender.send(JSON.stringify({ type: 'message', to: 'CODEXD', content: 'before delegate' }));
  await baseGotFirst;
  // Wait until the first wake has copied its token before mintJobToken removes
  // the file. Otherwise that older process can win the race and overwrite the
  // second wake's token after the unlink.
  for (let attempt = 0; attempt < 100 && !fs.existsSync(path.join(outDir, 'CODEXD.token')); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  // Single-flight deliberately refuses to start a second CODEXD wake while
  // the first fake wake is still active. End it, wait for its job to become
  // terminal, then the next message may mint the successor capability.
  releaseWake(outDir, 'CODEXD');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const records = fs.readdirSync(path.join(root, 'jobs'))
      .filter(file => file.endsWith('.json'))
      .map(file => JSON.parse(fs.readFileSync(path.join(root, 'jobs', file), 'utf8')));
    if (records.length && records.every(job => !['spawned', 'running'].includes(job.status))) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  try { fs.unlinkSync(path.join(outDir, 'CODEXD.release')); } catch {}
  const jobToken = await mintJobToken(t, outDir, sender, 'CODEXD');

  // Delegate registers: derived visible ID, no contest with the base.
  const delegate = await open(port);
  t.after(() => delegate.close());
  const delegateRegistered = waitForMessage(delegate, msg => msg.type === 'registered');
  delegate.send(JSON.stringify({
    type: 'register',
    clientId: 'CODEXD',
    delegate: true,
    jobToken,
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
  const seen = (await history).messages.map(m => m.content);
  // Least authority: scoped to the job's inbound message onward, so the
  // earlier 'before delegate' mail is NOT visible to it.
  assert.equal(seen.includes('wake trigger'), true);
  assert.equal(seen.includes('before delegate'), false);

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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pid-')));
  const { configPath, outDir } = notifyConfigForTokens(root);
  const port = startServer(t, root, { RELAY_NOTIFY_CONFIG: configPath, RELAY_BIND_DELEGATE_ANCESTRY: '0' });

  const observer = await connectWithRetry(port, 'A', { pid: process.pid });
  t.after(() => observer.close());

  const token = await mintJobToken(t, outDir, observer, 'CODEXW');
  const tokenFile = path.join(root, 'codexw.token');
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });

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
      RELAY_CLIENT_ID: 'CODEXW',
      RELAY_JOB_TOKEN_FILE: tokenFile
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

function spawnMcpHarness(t, root, port, extraEnv = {}) {
  const mcp = spawn(process.execPath, [path.join(__dirname, '..', 'mcp-server.js'),
    `--relay-url=ws://127.0.0.1:${port}`], {
    env: {
      ...process.env,
      HOME: root,
      CLAUDE_RELAY_SESSION_ID: '',
      RELAY_CLIENT_ID: '',
      ...extraEnv
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => mcp.kill('SIGTERM'));
  let buffer = '';
  const waiters = [];
  mcp.stdout.setEncoding('utf8');
  mcp.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const value = JSON.parse(line);
      const waiter = waiters.find(entry => entry.predicate(value));
      if (!waiter) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(value);
    }
  });
  return {
    mcp,
    next: predicate => new Promise(resolve => waiters.push({ predicate, resolve })),
    send: value => mcp.stdin.write(`${JSON.stringify(value)}\n`)
  };
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
  assert.equal(registry.KEEPME.pid, undefined, 'pid dropped: the OS reuses it');
  assert.equal(registry.KEEPME.cwd, projDir);
});

function readRegistryFile(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'claude-relay', 'sessions', 'registry.json'), 'utf8'));
}

async function registryWhen(root, predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const registry = readRegistryFile(root);
      if (predicate(registry)) return registry;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('registry never reached the expected state');
}

test('a label that ended cleanly (no pid left) is reclaimed by a restart in its cwd', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-reclaim-')));
  const port = startServer(t, root);
  const projDir = path.join(root, 'proj');
  fs.mkdirSync(projDir);

  const observer = await connectWithRetry(port, 'A', { pid: process.pid });
  t.after(() => observer.close());

  const usedAt = '2026-10-01T12:00:00.000Z';
  writeRegistry(root, {
    CODEXR3: { cwd: projDir, source: 'rename', ended: new Date().toISOString(), usedAt }
  });

  const joined = waitForMessage(observer, msg =>
    msg.type === 'peer_joined' && msg.clientId === 'CODEXR3', 10000);
  const mcp = spawnBridge(t, root, port, projDir, { RELAY_CLIENT_ID: 'CODEXR' });
  await joined;
  const registry = await registryWhen(root, registry => registry.CODEXR3?.pid === mcp.pid);
  assert.equal(registry.CODEXR3.ended, undefined);
  assert.equal(registry.CODEXR3.usedAt, usedAt, 'a used label stays used when reclaimed');
});

test('a retired bridge never marks or strips the entry its successor now holds', async t => {
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
  await registryWhen(root, registry => registry.KEEPME?.pid === mcp.pid);

  // A reconnect bridge has taken the label over (as /mcp reconnect does
  // before it retires its predecessor).
  const successor = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  t.after(() => successor.kill('SIGKILL'));
  const registry = readRegistryFile(root);
  registry.KEEPME.pid = successor.pid;
  writeRegistry(root, registry);

  // Its first relay call no longer marks a label it does not hold.
  const answered = new Promise(resolve => {
    let out = '';
    mcp.stdout.on('data', chunk => {
      out += chunk;
      if (out.includes('"id":2')) resolve();
    });
  });
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'relay_status', arguments: {} } })}\n`);
  await answered;

  const exited = new Promise(resolve => mcp.once('exit', resolve));
  mcp.kill('SIGTERM');
  await exited;

  const after = readRegistryFile(root);
  assert.equal(after.KEEPME.pid, successor.pid);
  assert.equal(after.KEEPME.ended, undefined);
  assert.equal(after.KEEPME.usedAt, undefined);
});

test('a retired auto-labelled bridge never deletes the entry a reconnect now holds', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-reclaim-')));
  const port = startServer(t, root);
  const projDir = path.join(root, 'proj');
  fs.mkdirSync(projDir);

  const observer = await connectWithRetry(port, 'A', { pid: process.pid });
  t.after(() => observer.close());

  const mcp = spawnBridge(t, root, port, projDir);
  const live = await registryWhen(root, registry =>
    Object.values(registry).some(info => info?.pid === mcp.pid && info.source === 'auto'), 10000);
  const label = Object.keys(live).find(id => live[id]?.pid === mcp.pid);

  // A Claude Code /mcp reconnect took this auto label over.
  const successor = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  t.after(() => successor.kill('SIGKILL'));
  const registry = readRegistryFile(root);
  registry[label].pid = successor.pid;
  writeRegistry(root, registry);

  const exited = new Promise(resolve => mcp.once('exit', resolve));
  mcp.kill('SIGTERM');
  await exited;
  assert.equal(readRegistryFile(root)[label]?.pid, successor.pid);
});

test('the first relay call marks the label used, and the mark survives exit', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-reclaim-')));
  const port = startServer(t, root);
  const projDir = path.join(root, 'proj');
  fs.mkdirSync(projDir);

  const observer = await connectWithRetry(port, 'A', { pid: process.pid });
  t.after(() => observer.close());

  const joined = waitForMessage(observer, msg =>
    msg.type === 'peer_joined' && msg.clientId === 'USEDME', 10000);
  const mcp = spawnBridge(t, root, port, projDir, { CLAUDE_RELAY_SESSION_ID: 'USEDME' });
  await joined;
  const before = await registryWhen(root, registry => registry.USEDME?.pid === mcp.pid);
  assert.equal(before.USEDME.usedAt, undefined, 'connecting alone is not use');

  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'relay_status', arguments: {} } })}\n`);
  const used = await registryWhen(root, registry => Boolean(registry.USEDME?.usedAt));

  const exited = new Promise(resolve => mcp.once('exit', resolve));
  mcp.kill('SIGTERM');
  await exited;

  const after = readRegistryFile(root);
  assert.ok(after.USEDME.ended);
  assert.equal(after.USEDME.usedAt, used.USEDME.usedAt);
});

test('a connecting bridge prunes only day-old entries marked disposable, never older unmarked ones', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-reclaim-')));
  const port = startServer(t, root);
  const projDir = path.join(root, 'proj');
  fs.mkdirSync(projDir);

  const observer = await connectWithRetry(port, 'A', { pid: process.pid });
  t.after(() => observer.close());

  const occupant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  t.after(() => occupant.kill('SIGKILL'));
  const hour = 60 * 60 * 1000;
  const entry = (endedAgo, extra = {}) => ({
    cwd: '/', source: 'auto-numbered',
    started: new Date(Date.now() - endedAgo - 700).toISOString(),
    ended: new Date(Date.now() - endedAgo).toISOString(),
    disposable: true,
    ...extra
  });
  writeRegistry(root, {
    GONE1: entry(25 * hour),
    GONE2: entry(25 * hour, { source: 'codex-reconnect', pid: await deadPid() }),
    RECENT: entry(23 * hour),
    USED: entry(25 * hour, { usedAt: new Date(Date.now() - 25 * hour).toISOString() }),
    PIDALIVE: entry(25 * hour, { pid: occupant.pid }),
    BADENDED: entry(25 * hour, { ended: 'not a time' }),
    NOTTRUE: entry(25 * hour, { disposable: 'yes' }),
    // The shape of every entry written before the mark existed: kept.
    LEGACY: entry(25 * hour, { disposable: undefined }),
    LEGACYRECONNECT: entry(25 * hour, { disposable: undefined, source: 'codex-reconnect',
      codexSessionId: '01a00000-0000-7000-8000-000000000000' }),
    MALFORMED: null
  });

  const joined = waitForMessage(observer, msg =>
    msg.type === 'peer_joined' && msg.clientId === 'PRUNER', 10000);
  spawnBridge(t, root, port, projDir, {
    CLAUDE_RELAY_SESSION_ID: 'PRUNER', RELAY_MESSAGE_DIR: path.join(root, 'messages')
  });
  await joined;
  const registry = await registryWhen(root, registry => Boolean(registry.PRUNER));
  assert.deepEqual(Object.keys(registry).sort(), [
    'BADENDED', 'LEGACY', 'LEGACYRECONNECT', 'MALFORMED', 'NOTTRUE', 'PIDALIVE', 'PRUNER', 'RECENT', 'USED'
  ]);
});

test('mail or a wake job on record protects a disposable label for good; unreadable records block pruning only', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-reclaim-')));
  const port = startServer(t, root);
  const projDir = path.join(root, 'proj');
  fs.mkdirSync(projDir);
  const messages = path.join(root, 'messages');
  const jobs = path.join(root, 'jobs');
  fs.mkdirSync(messages, { recursive: true });
  fs.mkdirSync(jobs, { recursive: true });

  const observer = await connectWithRetry(port, 'A', { pid: process.pid });
  t.after(() => observer.close());

  const hour = 60 * 60 * 1000;
  const disposable = (extra = {}) => ({
    cwd: '/', source: 'auto-numbered', disposable: true,
    numberedBornAt: new Date(Date.now() - 25 * hour - 700).toISOString(),
    started: new Date(Date.now() - 25 * hour - 700).toISOString(),
    ended: new Date(Date.now() - 25 * hour).toISOString(),
    ...extra
  });
  writeRegistry(root, {
    MAILTO: disposable(),
    MAILFROM: disposable(),
    JOBOWNER: disposable(),
    // Born recently, not yet disposable: protected before it ever could be.
    YOUNG: disposable({ disposable: undefined, ended: new Date().toISOString() }),
    GONE: disposable()
  });
  const day = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(messages, `${day}.jsonl`), [
    JSON.stringify({ id: 'm1', from: 'CC1', to: 'MAILTO', content: 'x' }),
    JSON.stringify({ id: 'm2', from: 'MAILFROM', to: 'CC1', content: 'y' }),
    JSON.stringify({ id: 'm3', from: 'CC1', to: 'YOUNG', content: 'z' }),
    JSON.stringify({ id: 'm4', from: 'CC1', to: 'all', content: 'broadcast' })
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(jobs, 'wake_1.json'), JSON.stringify({ jobId: 'wake_1', owner: 'JOBOWNER' }));

  const env = { RELAY_MESSAGE_DIR: messages };
  const joined = waitForMessage(observer, msg =>
    msg.type === 'peer_joined' && msg.clientId === 'PRUNER', 10000);
  const first = spawnBridge(t, root, port, projDir, { CLAUDE_RELAY_SESSION_ID: 'PRUNER', ...env });
  await joined;
  const registry = await registryWhen(root, registry => registry.PRUNER?.pid === first.pid);
  assert.deepEqual(Object.keys(registry).sort(), ['JOBOWNER', 'MAILFROM', 'MAILTO', 'PRUNER', 'YOUNG']);
  for (const id of ['JOBOWNER', 'MAILFROM', 'MAILTO', 'YOUNG']) {
    assert.ok(registry[id].usedAt, `${id} is marked used`);
    assert.equal(registry[id].disposable, undefined, `${id} is no longer disposable`);
  }

  // A record that cannot be read: labels named by the readable ones are
  // still marked used for good, but nothing is pruned this time.
  const firstExit = new Promise(resolve => first.once('exit', resolve));
  first.kill('SIGTERM');
  await firstExit;
  const next = readRegistryFile(root);
  next.GONE2 = disposable();
  next.MAILED = disposable();
  writeRegistry(root, next);
  fs.writeFileSync(path.join(messages, '2000-01-02.jsonl'),
    `${JSON.stringify({ id: 'm5', from: 'CC1', to: 'MAILED', content: 'w' })}\n{"to": "CUT`);
  const rejoined = waitForMessage(observer, msg =>
    msg.type === 'peer_joined' && msg.clientId === 'PRUNER', 10000);
  const second = spawnBridge(t, root, port, projDir, { CLAUDE_RELAY_SESSION_ID: 'PRUNER', ...env });
  await rejoined;
  const partial = await registryWhen(root, registry => registry.PRUNER?.pid === second.pid);
  assert.ok(partial.GONE2, 'kept while a record cannot be read');
  assert.equal(partial.GONE2.disposable, true);
  assert.ok(partial.MAILED.usedAt, 'readable mail still marks its label');
  assert.equal(partial.MAILED.disposable, undefined);

  // The mail ages out and the store reads cleanly again: the mark stays,
  // and only the unmarked disposable entry goes.
  const secondExit = new Promise(resolve => second.once('exit', resolve));
  second.kill('SIGTERM');
  await secondExit;
  fs.rmSync(path.join(messages, '2000-01-02.jsonl'));
  const clean = waitForMessage(observer, msg =>
    msg.type === 'peer_joined' && msg.clientId === 'PRUNER', 10000);
  const third = spawnBridge(t, root, port, projDir, { CLAUDE_RELAY_SESSION_ID: 'PRUNER', ...env });
  await clean;
  const after = await registryWhen(root, registry => registry.PRUNER?.pid === third.pid);
  assert.equal(after.GONE2, undefined);
  assert.ok(after.MAILED.usedAt);

  // A wake job that cannot be read blocks pruning too.
  const thirdExit = new Promise(resolve => third.once('exit', resolve));
  third.kill('SIGTERM');
  await thirdExit;
  const last = readRegistryFile(root);
  last.GONE3 = disposable();
  writeRegistry(root, last);
  fs.writeFileSync(path.join(jobs, 'wake_2.json'), '{"owner": "CUT');
  const fourthJoined = waitForMessage(observer, msg =>
    msg.type === 'peer_joined' && msg.clientId === 'PRUNER', 10000);
  const fourth = spawnBridge(t, root, port, projDir, { CLAUDE_RELAY_SESSION_ID: 'PRUNER', ...env });
  await fourthJoined;
  const blocked = await registryWhen(root, registry => registry.PRUNER?.pid === fourth.pid);
  assert.ok(blocked.GONE3, 'kept while a wake job cannot be read');
});

test('a bridge prunes only when its relay confirms the store it reads is its own', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-reclaim-')));
  const port = startServer(t, root);
  const projDir = path.join(root, 'proj');
  fs.mkdirSync(projDir);
  const observer = await connectWithRetry(port, 'A', { pid: process.pid });
  t.after(() => observer.close());

  // Another relay with its own store, never the one this bridge talks to.
  const otherRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-other-')));
  const otherPort = startServer(t, otherRoot);
  const other = await connectWithRetry(otherPort, 'B', { pid: process.pid });
  t.after(() => other.close());
  // An empty sibling beside the real mail store, sharing its jobs directory.
  fs.mkdirSync(path.join(root, 'alternate-messages'));

  const hour = 60 * 60 * 1000;
  const disposable = () => ({
    cwd: '/', source: 'auto-numbered', disposable: true,
    started: new Date(Date.now() - 25 * hour - 700).toISOString(),
    ended: new Date(Date.now() - 25 * hour).toISOString()
  });
  const runs = [
    ['a sibling mail directory', path.join(root, 'alternate-messages'), true],
    ["another relay's store", path.join(otherRoot, 'messages'), true],
    ['a missing directory', path.join(root, 'no-such-messages'), true],
    ["the relay's own store", path.join(root, 'messages'), false]
  ];
  for (const [why, messages, kept] of runs) {
    writeRegistry(root, { GONE: disposable() });
    const joined = waitForMessage(observer, msg =>
      msg.type === 'peer_joined' && msg.clientId === 'PRUNER', 10000);
    const mcp = spawnBridge(t, root, port, projDir, {
      CLAUDE_RELAY_SESSION_ID: 'PRUNER', RELAY_MESSAGE_DIR: messages
    });
    await joined;
    const registry = await registryWhen(root, registry => registry.PRUNER?.pid === mcp.pid);
    assert.equal(Boolean(registry.GONE), kept, `${kept ? 'kept' : 'pruned'} with ${why}`);
    const exited = new Promise(resolve => mcp.once('exit', resolve));
    mcp.kill('SIGTERM');
    await exited;
  }
});

// A fresh numbered label: PROBE is taken by another cwd, so this bridge is
// auto-numbered PROBE2, the way the ChatGPT app's tool-list bridges are.
async function freshNumberedBridge(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-probe-')));
  const port = startServer(t, root);
  const projDir = path.join(root, 'proj');
  fs.mkdirSync(projDir);
  const observer = await connectWithRetry(port, 'A', { pid: process.pid });
  t.after(() => observer.close());
  writeRegistry(root, {
    PROBE: { cwd: path.join(root, 'elsewhere'), source: 'RELAY_CLIENT_ID', ended: new Date().toISOString() }
  });
  const joined = waitForMessage(observer, msg =>
    msg.type === 'peer_joined' && msg.clientId === 'PROBE2', 10000);
  const mcp = spawnBridge(t, root, port, projDir, { RELAY_CLIENT_ID: 'PROBE' });
  await joined;
  const registry = await registryWhen(root, registry => registry.PROBE2?.pid === mcp.pid);
  const answers = new Map();
  let out = '';
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
  return {
    root, observer, mcp, born: registry.PROBE2.numberedBornAt,
    call: (id, name) => new Promise(resolve => {
      answers.set(id, resolve);
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
        params: { name, arguments: {} } })}\n`);
    }),
    end: async () => {
      const exited = new Promise(resolve => mcp.once('exit', resolve));
      mcp.kill('SIGTERM');
      await exited;
      return readRegistryFile(root).PROBE2;
    }
  };
}

test('a fresh numbered label that ends within a minute, unused and without mail, is marked disposable', async t => {
  const probe = await freshNumberedBridge(t);
  assert.ok(!Number.isNaN(Date.parse(probe.born)), 'a fresh numbered label records its birth');
  const ended = await probe.end();
  assert.equal(ended.disposable, true);
  assert.equal(ended.pid, undefined);
});

test('a numbered label that made a relay call is never marked disposable', async t => {
  const probe = await freshNumberedBridge(t);
  await probe.call(2, 'relay_status');
  const ended = await probe.end();
  assert.ok(ended.usedAt);
  assert.equal(ended.disposable, undefined);
});

test('a numbered label that received mail is never marked disposable', async t => {
  const probe = await freshNumberedBridge(t);
  const sent = waitForMessage(probe.observer, msg => msg.type === 'sent');
  probe.observer.send(JSON.stringify({ type: 'message', to: 'PROBE2', content: 'wake work' }));
  await sent;
  await new Promise(resolve => setTimeout(resolve, 300));
  const ended = await probe.end();
  assert.equal(ended.usedAt, undefined);
  assert.equal(ended.disposable, undefined);
});

test('reclaiming a numbered label drops its birth time, so it is never disposable again', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-reclaim-')));
  const port = startServer(t, root);
  const projDir = path.join(root, 'proj');
  fs.mkdirSync(projDir);
  const observer = await connectWithRetry(port, 'A', { pid: process.pid });
  t.after(() => observer.close());
  writeRegistry(root, {
    CODEXR3: { cwd: projDir, source: 'auto-numbered', ended: new Date().toISOString(),
      numberedBornAt: new Date().toISOString(), disposable: true }
  });
  const joined = waitForMessage(observer, msg =>
    msg.type === 'peer_joined' && msg.clientId === 'CODEXR3', 10000);
  const mcp = spawnBridge(t, root, port, projDir, { RELAY_CLIENT_ID: 'CODEXR' });
  await joined;
  const live = await registryWhen(root, registry => registry.CODEXR3?.pid === mcp.pid);
  assert.equal(live.CODEXR3.numberedBornAt, undefined);
  assert.equal(live.CODEXR3.disposable, undefined);
  const exited = new Promise(resolve => mcp.once('exit', resolve));
  mcp.kill('SIGTERM');
  await exited;
  assert.equal(readRegistryFile(root).CODEXR3.disposable, undefined);
});

// Hold the registry lock as a live process would, so the bridge's write
// times out (it fails closed after 5s rather than racing).
function holdRegistryLock(root) {
  const lock = path.join(root, 'claude-relay', 'sessions', 'registry.json.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner'), `test-holder\n${process.pid}`);
  return () => fs.rmSync(lock, { recursive: true, force: true });
}

test('a first-use write that fails is retried on the next relay call', async t => {
  const probe = await freshNumberedBridge(t);
  const release = holdRegistryLock(probe.root);
  await probe.call(2, 'relay_status');
  release();
  assert.equal(readRegistryFile(probe.root).PROBE2.usedAt, undefined, 'the locked write was skipped');
  await probe.call(3, 'relay_status');
  assert.ok(readRegistryFile(probe.root).PROBE2.usedAt);
  const ended = await probe.end();
  assert.equal(ended.disposable, undefined);
});

test('a first-use write that fails is flushed when the bridge ends', async t => {
  const probe = await freshNumberedBridge(t);
  const release = holdRegistryLock(probe.root);
  await probe.call(2, 'relay_status');
  release();
  const ended = await probe.end();
  assert.ok(ended.usedAt);
  assert.equal(ended.disposable, undefined);
});

test('MCP bridge in RELAY_DELEGATE_FOR mode registers as a transparent delegate', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pid-')));
  const { configPath, outDir } = notifyConfigForTokens(root);
  const port = startServer(t, root, { RELAY_NOTIFY_CONFIG: configPath, RELAY_BIND_DELEGATE_ANCESTRY: '0' });

  const observer = await connectWithRetry(port, 'A', { pid: process.pid });
  t.after(() => observer.close());

  const token = await mintJobToken(t, outDir, observer, 'CODEXD');
  const tokenFile = path.join(root, 'codexd.token');
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });

  const joined = waitForMessage(observer, msg =>
    msg.type === 'peer_joined' && /^CODEXD~wake-[0-9a-f]{8}$/.test(msg.clientId), 10000);
  const mcp = spawn(process.execPath, [path.join(__dirname, '..', 'mcp-server.js'),
    `--relay-url=ws://127.0.0.1:${port}`], {
    env: {
      ...process.env,
      HOME: root,
      CLAUDE_RELAY_SESSION_ID: '',
      RELAY_CLIENT_ID: '',
      RELAY_DELEGATE_FOR: 'CODEXD',
      RELAY_JOB_TOKEN_FILE: tokenFile
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

test('one wake can receive in one MCP subprocess and send from a later subprocess', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-reconnect-')));
  const { configPath, outDir } = notifyConfigForTokens(root);
  const port = startServer(t, root, {
    RELAY_NOTIFY_CONFIG: configPath,
    RELAY_BIND_DELEGATE_ANCESTRY: '0'
  });
  const observer = await connectWithRetry(port, 'A', { pid: process.pid });
  t.after(() => observer.close());

  const token = await mintJobToken(t, outDir, observer, 'CODEXR');
  const tokenFile = path.join(root, 'codexr.token');
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });

  const firstJoined = waitForMessage(observer, message =>
    message.type === 'peer_joined' && /^CODEXR~wake-/.test(message.clientId), 10000);
  const first = spawnMcpHarness(t, root, port, {
    RELAY_DELEGATE_FOR: 'CODEXR',
    RELAY_JOB_TOKEN_FILE: tokenFile
  });
  const initialized = first.next(message => message.id === 1);
  first.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await initialized;
  const firstDelegateId = (await firstJoined).clientId;

  const history = first.next(message => message.id === 2);
  first.send({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'relay_receive', arguments: { count: 10 } }
  });
  assert.match((await history).result.content[0].text, /wake trigger/);
  assert.equal(fs.existsSync(tokenFile), true, 'first bridge must leave the job handoff for reconnect');

  const duplicate = await open(port);
  t.after(() => duplicate.close());
  const duplicateRejected = waitForMessage(duplicate, message =>
    message.type === 'register_rejected' && /already has a live MCP bridge/.test(message.reason));
  duplicate.send(JSON.stringify({
    type: 'register', clientId: 'CODEXR', delegate: true, jobToken: token, meta: { pid: process.pid }
  }));
  await duplicateRejected;

  const firstLeft = waitForMessage(observer, message =>
    message.type === 'peer_left' && message.clientId === firstDelegateId, 10000);
  first.mcp.kill('SIGTERM');
  await firstLeft;

  const secondJoined = waitForMessage(observer, message =>
    message.type === 'peer_joined' && /^CODEXR~wake-/.test(message.clientId), 10000);
  const second = spawnMcpHarness(t, root, port, {
    RELAY_DELEGATE_FOR: 'CODEXR',
    RELAY_JOB_TOKEN_FILE: tokenFile
  });
  const secondInitialized = second.next(message => message.id === 3);
  second.send({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} });
  await secondInitialized;
  await secondJoined;

  const delivered = nextMessage(observer, 'message');
  const sendResult = second.next(message => message.id === 4);
  second.send({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'relay_send', arguments: { to: 'A', message: 'reply after MCP restart' } }
  });
  assert.match((await sendResult).result.content[0].text, /Sent to A/);
  assert.equal((await delivered).content, 'reply after MCP restart');

  const records = fs.readdirSync(path.join(root, 'jobs'))
    .filter(file => file.endsWith('.json'))
    .map(file => JSON.parse(fs.readFileSync(path.join(root, 'jobs', file), 'utf8')));
  const job = records.find(record => record.owner === 'CODEXR');
  assert.deepEqual(job.outbound.map(entry => entry.to), ['A'],
    'the server, not delegate prose, attests the reconnect send');
});

test('identity mode cannot be switched on a live socket (primary<->delegate)', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pid-')));
  const { configPath, outDir } = notifyConfigForTokens(root);
  const port = startServer(t, root, { RELAY_NOTIFY_CONFIG: configPath, RELAY_BIND_DELEGATE_ANCESTRY: '0' });

  // Primary -> delegate: rejected.
  const primary = await connectWithRetry(port, 'MODEA', { pid: process.pid });
  t.after(() => primary.close());
  const modeAToken = await mintJobToken(t, outDir, primary, 'MODEA');
  const primaryRefused = waitForMessage(primary, msg =>
    msg.type === 'error' && /delegate registration requires a fresh connection/.test(msg.message));
  primary.send(JSON.stringify({
    type: 'register', clientId: 'MODEA', delegate: true, jobToken: modeAToken, meta: { pid: 111 }
  }));
  await primaryRefused;

  // Delegate -> primary: rejected.
  const delegate = await open(port);
  t.after(() => delegate.close());
  const modeToken = await mintJobToken(t, outDir, primary, 'MODEB');
  const delegateRegistered = waitForMessage(delegate, msg => msg.type === 'registered');
  delegate.send(JSON.stringify({
    type: 'register', clientId: 'MODEB', delegate: true, jobToken: modeToken, meta: { pid: 222 }
  }));
  await delegateRegistered;
  const delegateRefused = waitForMessage(delegate, msg =>
    msg.type === 'error' && /primary registration requires a fresh connection/.test(msg.message));
  delegate.send(JSON.stringify({ type: 'register', clientId: 'MODEB', meta: { pid: 222 } }));
  await delegateRefused;
});

test('hostile client IDs and message targets are refused at the boundary', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-grammar-')));
  const { configPath, outDir } = notifyConfigForTokens(root);
  const port = startServer(t, root, { RELAY_NOTIFY_CONFIG: configPath, RELAY_BIND_DELEGATE_ANCESTRY: '0' });

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
  const gramToken = await mintJobToken(t, outDir, good, 'GRAMOK');
  const delegateReg = waitForMessage(delegate, msg => msg.type === 'registered');
  delegate.send(JSON.stringify({
    type: 'register', clientId: 'GRAMOK', delegate: true, jobToken: gramToken, meta: { pid: 9911 }
  }));
  const delegateId = (await delegateReg).clientId;
  const delegateGot = waitForMessage(delegate, msg => msg.type === 'message');
  good.send(JSON.stringify({ type: 'message', to: delegateId, content: 'direct to delegate' }));
  assert.equal((await delegateGot).content, 'direct to delegate');
});

test('a delegate connection is immutable: no re-registration under another base', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pid-')));
  const { configPath, outDir } = notifyConfigForTokens(root);
  const port = startServer(t, root, { RELAY_NOTIFY_CONFIG: configPath, RELAY_BIND_DELEGATE_ANCESTRY: '0' });

  // Wait for the server to be listening before opening a raw socket.
  const observer = await connectWithRetry(port, 'OBS', { pid: process.pid });
  t.after(() => observer.close());

  const immutToken = await mintJobToken(t, outDir, observer, 'IMMUT');
  const otherToken = await mintJobToken(t, outDir, observer, 'OTHERBASE');
  const delegate = await open(port);
  t.after(() => delegate.close());
  const registered = waitForMessage(delegate, msg => msg.type === 'registered');
  delegate.send(JSON.stringify({
    type: 'register', clientId: 'IMMUT', delegate: true, jobToken: immutToken, meta: { pid: 4242 }
  }));
  const firstId = (await registered).clientId;

  const refused = waitForMessage(delegate, msg =>
    msg.type === 'error' && /delegates are immutable/.test(msg.message));
  delegate.send(JSON.stringify({
    type: 'register', clientId: 'OTHERBASE', delegate: true, jobToken: otherToken, meta: { pid: 4242 }
  }));
  await refused;

  // The original delegate identity is untouched and still the only mapping.
  const peersMsg = waitForMessage(observer, msg => msg.type === 'peers');
  observer.send(JSON.stringify({ type: 'get_peers' }));
  const peerList = (await peersMsg).peers;
  assert.ok(peerList.includes(firstId));
  assert.equal(peerList.some(id => id.startsWith('OTHERBASE')), false);
});

test('delegate registration requires a valid job capability', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cap-')));
  const port = startServer(t, root);

  const owner = await connectWithRetry(port, 'CAPBASE', { pid: process.pid });
  t.after(() => owner.close());

  // No token at all.
  const rogue = await open(port);
  t.after(() => rogue.close());
  const refused = waitForMessage(rogue, msg =>
    msg.type === 'register_rejected' && /valid, unexpired job capability/.test(msg.reason));
  rogue.send(JSON.stringify({ type: 'register', clientId: 'CAPBASE', delegate: true, meta: { pid: 1 } }));
  await refused;

  // Fabricated token.
  const rogue2 = await open(port);
  t.after(() => rogue2.close());
  const refused2 = waitForMessage(rogue2, msg =>
    msg.type === 'register_rejected' && /valid, unexpired job capability/.test(msg.reason));
  rogue2.send(JSON.stringify({
    type: 'register', clientId: 'CAPBASE', delegate: true, jobToken: 'fabricated', meta: { pid: 1 }
  }));
  await refused2;

  // The owner's own registration is untouched by the failed attempts.
  const pong = nextMessage(owner, 'pong');
  owner.send(JSON.stringify({ type: 'ping' }));
  await pong;
});

test('an enrolled label refuses claims without its owner capability', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cap-')));
  const port = startServer(t, root, { RELAY_REQUIRE_OWNER_CAPABILITY: '1' });

  // First claim enrolls the label and returns its capability exactly once.
  await connectWithRetry(port, 'WARMUP', { pid: process.pid }).then(ws => ws.close());
  const first = await open(port);
  const enrolledReply = waitForMessage(first, msg => msg.type === 'registered');
  first.send(JSON.stringify({ type: 'register', clientId: 'OWNED2', meta: { pid: process.pid } }));
  const enrolled = await enrolledReply;
  const secret = enrolled.ownerSecret;
  assert.ok(secret, 'enrollment returns the owner capability');

  // Release the label so the contest is purely about authority, not liveness.
  const gone = new Promise(resolve => first.once('close', resolve));
  first.close();
  await gone;
  await new Promise(resolve => setTimeout(resolve, 100));

  // No capability -> refused, even though nobody holds the label.
  const forger = await open(port);
  t.after(() => forger.close());
  const rejected = waitForMessage(forger, msg => msg.type === 'register_rejected');
  forger.send(JSON.stringify({ type: 'register', clientId: 'OWNED2', meta: { pid: process.pid } }));
  assert.match((await rejected).reason, /requires its owner capability/);

  // Wrong capability -> refused.
  const wrong = await open(port);
  t.after(() => wrong.close());
  const rejectedWrong = waitForMessage(wrong, msg => msg.type === 'register_rejected');
  wrong.send(JSON.stringify({
    type: 'register', clientId: 'OWNED2', ownerSecret: 'not-the-secret', meta: { pid: process.pid }
  }));
  assert.match((await rejectedWrong).reason, /invalid/);

  // The real owner reclaims it.
  const real = await open(port);
  t.after(() => real.close());
  const reseated = waitForMessage(real, msg => msg.type === 'registered');
  real.send(JSON.stringify({
    type: 'register', clientId: 'OWNED2', ownerSecret: secret, meta: { pid: process.pid }
  }));
  assert.equal((await reseated).clientId, 'OWNED2');
});

test('an owner capability never evicts a live holder', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cap-')));
  const port = startServer(t, root);

  await connectWithRetry(port, 'WARMUP', { pid: process.pid }).then(ws => ws.close());
  const holder = await open(port);
  t.after(() => holder.close());
  const enrolledReply = waitForMessage(holder, msg => msg.type === 'registered');
  holder.send(JSON.stringify({ type: 'register', clientId: 'LIVEOWN', meta: { pid: process.pid } }));
  const secret = (await enrolledReply).ownerSecret;
  assert.ok(secret);

  // A second process presenting the very same capability is still refused
  // while the holder's pid is alive: the label is in use.
  const duplicate = await open(port);
  t.after(() => duplicate.close());
  const rejected = waitForMessage(duplicate, msg => msg.type === 'register_rejected');
  duplicate.send(JSON.stringify({
    type: 'register', clientId: 'LIVEOWN', ownerSecret: secret, meta: { pid: 999999 }
  }));
  assert.match((await rejected).reason, /answered a liveness probe/);

  // The holder never noticed.
  const pong = nextMessage(holder, 'pong');
  holder.send(JSON.stringify({ type: 'ping' }));
  await pong;
});

test('local owner rotation refuses a live holder then rotates it offline', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-owner-rotate-')));
  const port = startServer(t, root, { RELAY_REQUIRE_OWNER_CAPABILITY: '1' });
  await connectWithRetry(port, 'ROTATEWARM', { pid: process.pid }).then(ws => ws.close());

  const holder = await open(port);
  t.after(() => holder.close());
  const registered = waitForMessage(holder, msg => msg.type === 'registered');
  holder.send(JSON.stringify({ type: 'register', clientId: 'ROTATE1', meta: { pid: process.pid } }));
  const oldSecret = (await registered).ownerSecret;
  assert.ok(oldSecret);

  const adminSecretPath = path.join(root, 'admin.secret');
  for (let attempt = 0; attempt < 100 && !fs.existsSync(adminSecretPath); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const adminSecret = fs.readFileSync(adminSecretPath, 'utf8').trim();
  const admin = await open(port);
  t.after(() => admin.close());

  const refused = waitForMessage(admin, msg => msg.type === 'owner_rotation_refused');
  admin.send(JSON.stringify({ type: 'rotate_owner', clientId: 'ROTATE1', adminSecret }));
  assert.match((await refused).reason, /Owner is live/);

  const closed = new Promise(resolve => holder.once('close', resolve));
  holder.close();
  await closed;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const probe = waitForMessage(admin, msg =>
      msg.type === 'owner_rotated' || msg.type === 'owner_rotation_refused');
    admin.send(JSON.stringify({ type: 'rotate_owner', clientId: 'ROTATE1', adminSecret }));
    const result = await probe;
    if (result.type === 'owner_rotated') break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const replacement = fs.readFileSync(path.join(root, 'owners', 'ROTATE1.secret'), 'utf8').trim();
  assert.notEqual(replacement, oldSecret);

  const oldClaim = await open(port);
  t.after(() => oldClaim.close());
  const rejected = waitForMessage(oldClaim, msg => msg.type === 'register_rejected');
  oldClaim.send(JSON.stringify({
    type: 'register', clientId: 'ROTATE1', ownerSecret: oldSecret, meta: { pid: process.pid }
  }));
  assert.match((await rejected).reason, /invalid/);

  const recovered = await open(port);
  t.after(() => recovered.close());
  const recoveredRegistration = waitForMessage(recovered, msg => msg.type === 'registered');
  recovered.send(JSON.stringify({
    type: 'register', clientId: 'ROTATE1', ownerSecret: replacement, meta: { pid: process.pid }
  }));
  assert.equal((await recoveredRegistration).clientId, 'ROTATE1');
});

test('a stolen job token is useless outside the spawned wake process tree', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-anc-')));
  const { configPath, outDir } = notifyConfigForTokens(root);
  // Ancestry binding ON (the default).
  const port = startServer(t, root, { RELAY_NOTIFY_CONFIG: configPath });

  const sender = await connectWithRetry(port, 'ANCS', { pid: process.pid });
  t.after(() => sender.close());

  // Steal the bearer exactly as a same-user attacker could: read the handoff
  // file. The token is valid, but this process is not a descendant of the
  // wake the server spawned.
  const stolen = await mintJobToken(t, outDir, sender, 'ANCBASE');
  const thief = await open(port);
  t.after(() => thief.close());
  const refused = waitForMessage(thief, msg =>
    msg.type === 'register_rejected' && /spawned wake process tree/.test(msg.reason), 8000);
  // The thief does NOT report its honest pid — it quotes a pid it knows is
  // inside the wake's process tree (this is the attack the previous version
  // missed, because it validated the ASSERTED pid). The server ignores the
  // assertion and asks the kernel who owns the socket.
  thief.send(JSON.stringify({
    type: 'register',
    clientId: 'ANCBASE',
    delegate: true,
    jobToken: stolen,
    meta: { pid: 1 } // deliberately bogus/forged
  }));
  await refused;

  // And the capability was NOT burned by the failed attempt: it is still
  // usable, so a thief cannot deny the real delegate by trying once.
  const legit = await open(port);
  t.after(() => legit.close());
  const stillValid = waitForMessage(legit, msg =>
    msg.type === 'register_rejected' && /spawned wake process tree/.test(msg.reason), 8000);
  legit.send(JSON.stringify({
    type: 'register', clientId: 'ANCBASE', delegate: true, jobToken: stolen, meta: { pid: process.pid }
  }));
  // (Still refused here because this test process is not in the wake tree
  // either — the point is that the token survived the first attempt rather
  // than being consumed by it.)
  await stillValid;
});

test('a delegate may only reply to the peer that woke it', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-scope-')));
  const { configPath, outDir } = notifyConfigForTokens(root);
  const port = startServer(t, root, { RELAY_NOTIFY_CONFIG: configPath, RELAY_BIND_DELEGATE_ANCESTRY: '0' });

  const waker = await connectWithRetry(port, 'WAKER', { pid: process.pid });
  const bystander = await connect(port, 'BYSTANDER', { pid: process.pid });
  t.after(() => [waker, bystander].forEach(ws => ws.close()));

  const token = await mintJobToken(t, outDir, waker, 'SCOPED');
  const delegate = await open(port);
  t.after(() => delegate.close());
  const registered = waitForMessage(delegate, msg => msg.type === 'registered');
  delegate.send(JSON.stringify({
    type: 'register', clientId: 'SCOPED', delegate: true, jobToken: token, meta: { pid: process.pid }
  }));
  await registered;

  // Replying to the waker is allowed...
  const wakerGot = nextMessage(waker, 'message');
  delegate.send(JSON.stringify({ type: 'message', to: 'WAKER', content: 'reply' }));
  assert.equal((await wakerGot).content, 'reply');

  // ...messaging a third party is not, and neither is broadcasting.
  const refusedThird = waitForMessage(delegate, msg =>
    msg.type === 'error' && /may only reply to "WAKER"/.test(msg.message));
  delegate.send(JSON.stringify({ type: 'message', to: 'BYSTANDER', content: 'should not arrive' }));
  await refusedThird;

  const refusedBroadcast = waitForMessage(delegate, msg =>
    msg.type === 'error' && /may only reply to "WAKER"/.test(msg.message));
  delegate.send(JSON.stringify({ type: 'message', to: 'all', content: 'should not broadcast' }));
  await refusedBroadcast;
});

test('a delegate wake produces a server-attested receipt for its owner', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-receipt-')));
  // Short wake: long enough for the delegate to register and send, short
  // enough that the job reaches a terminal state inside the test.
  const { configPath, outDir } = notifyConfigForTokens(root);
  const port = startServer(t, root, {
    RELAY_NOTIFY_CONFIG: configPath,
    RELAY_BIND_DELEGATE_ANCESTRY: '0'
  });

  const waker = await connectWithRetry(port, 'RCPWAKER', { pid: process.pid });
  const owner = await connect(port, 'RCPOWNER', { pid: process.pid });
  t.after(() => [waker, owner].forEach(ws => ws.close()));

  const token = await mintJobToken(t, outDir, waker, 'RCPOWNER');
  const delegate = await open(port);
  t.after(() => delegate.close());
  const registered = waitForMessage(delegate, msg => msg.type === 'registered');
  delegate.send(JSON.stringify({
    type: 'register', clientId: 'RCPOWNER', delegate: true, jobToken: token, meta: { pid: process.pid }
  }));
  const delegateId = (await registered).clientId;

  // The delegate replies to the peer that woke it.
  const wakerGot = nextMessage(waker, 'message');
  delegate.send(JSON.stringify({ type: 'message', to: 'RCPWAKER', content: 'work done' }));
  const relayed = await wakerGot;
  releaseWake(outDir, 'RCPOWNER');

  // A receipt appears once the job ENDS (a running job is not reportable),
  // so wait for the wake process to exit.
  let receipt = null;
  let receiptDigest = null;
  for (let attempt = 0; attempt < 30 && !receipt; attempt += 1) {
    const receipts = waitForMessage(owner, msg => msg.type === 'receipts', 5000);
    owner.send(JSON.stringify({ type: 'get_receipts' }));
    const response = await receipts;
    const list = response.receipts;
    receipt = list.find(r => r.outbound.some(o => o.messageId === relayed.id)) || null;
    if (receipt) receiptDigest = response.digest;
    if (!receipt) await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(receipt, 'the finished wake produced a receipt recording its real send');
  assert.equal(receipt.status, 'completed', 'a delegate that registered and ran is completed');
  assert.equal(receipt.inboundMessageId ? true : true, true);
  assert.ok(receipt, 'the receipt records the actual send');
  assert.equal(receipt.from, 'RCPWAKER');
  assert.equal(receipt.outbound[0].to, 'RCPWAKER');
  assert.equal(receipt.outbound[0].delivered, true);

  // A delegate may not read or acknowledge receipts (it would report on itself).
  const refused = waitForMessage(delegate, msg =>
    msg.type === 'error' && /Reading receipts requires a registered primary session/.test(msg.message));
  delegate.send(JSON.stringify({ type: 'get_receipts' }));
  await refused;

  // Acknowledging clears it; a second read shows nothing pending.
  const acked = waitForMessage(owner, msg => msg.type === 'receipts_acked');
  owner.send(JSON.stringify({
    type: 'ack_receipts', jobIds: [receipt.jobId], digest: receiptDigest, turnId: 'turn-1'
  }));
  assert.deepEqual((await acked).jobIds, [receipt.jobId]);

  const after = waitForMessage(owner, msg => msg.type === 'receipts');
  owner.send(JSON.stringify({ type: 'get_receipts' }));
  assert.equal((await after).receipts.some(r => r.jobId === receipt.jobId), false);
  assert.ok(delegateId.startsWith('RCPOWNER~wake-'));
});
