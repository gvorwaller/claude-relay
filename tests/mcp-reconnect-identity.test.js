const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const WebSocket = require('ws');

function nextLine(stream) {
  let buffer = '';
  const waiters = [];
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const value = JSON.parse(line);
      const waiter = waiters.find(item => item.predicate(value));
      if (!waiter) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    }
  });
  return predicate => new Promise((resolve, reject) => {
    const waiter = { predicate, resolve };
    waiter.timer = setTimeout(() => reject(new Error('Timed out waiting for MCP output')), 5000);
    waiters.push(waiter);
  });
}

function wsMessage(ws, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for relay frame')), timeout);
    const handler = data => {
      const value = JSON.parse(data);
      if (!predicate(value)) return;
      clearTimeout(timer);
      ws.off('message', handler);
      resolve(value);
    };
    ws.on('message', handler);
  });
}

async function open(port, id) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const ready = wsMessage(ws, message => message.type === 'registered');
  ws.send(JSON.stringify({ type: 'register', clientId: id, meta: { pid: process.pid } }));
  await ready;
  return ws;
}

async function waitForSessionMeta(ws, clientId, predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const response = wsMessage(ws, message => message.type === 'sessions');
    ws.send(JSON.stringify({ type: 'get_sessions' }));
    const meta = (await response).sessions[clientId];
    if (meta && predicate(meta)) return meta;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for session metadata for ${clientId}`);
}

async function startRelay(t, root) {
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const selected = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(selected));
    });
  });
  const env = {
    ...process.env,
    RELAY_MESSAGE_DIR: path.join(root, 'messages'),
    RELAY_LOG_DIR: path.join(root, 'logs'),
    RELAY_CAPABILITY_FILE: path.join(root, 'capabilities.json'),
    RELAY_OWNER_SECRETS_DIR: path.join(root, 'server-owners')
  };
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), String(port)], {
    env, stdio: 'ignore'
  });
  t.after(() => server.kill('SIGTERM'));
  let observer;
  for (let attempt = 0; attempt < 100 && !observer; attempt += 1) {
    try { observer = await open(port, 'OBSERVER'); } catch { await new Promise(r => setTimeout(r, 25)); }
  }
  assert.ok(observer);
  t.after(() => observer.close());
  return { port, env, observer };
}

function startMcp(t, { root, port, cwd, env = {}, clientId }) {
  const argv = [path.join(__dirname, '..', 'mcp-server.js')];
  if (clientId) argv.push(`--client-id=${clientId}`);
  argv.push(`--relay-url=ws://127.0.0.1:${port}`);
  const mcp = spawn(process.execPath, argv, {
    cwd,
    env: { ...process.env, HOME: root, RELAY_CLIENT_ID: '', ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let errors = '';
  mcp.stderr.setEncoding('utf8');
  mcp.stderr.on('data', chunk => { errors += chunk; });
  t.after(() => mcp.kill('SIGTERM'));
  const next = nextLine(mcp.stdout);
  const send = value => mcp.stdin.write(`${JSON.stringify(value)}\n`);
  return { mcp, next, send, errors: () => errors };
}

function startCodexContinuation(t, { root, port, cwd, oldRollout, currentRollout, oldSession }) {
  const wrapper = spawn(process.execPath, [
    path.join(__dirname, 'fixtures', 'codex-rollout-parent.js'),
    path.join(__dirname, '..', 'mcp-server.js'),
    root,
    cwd,
    String(port),
    oldRollout,
    currentRollout,
    oldSession
  ], {
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let errors = '';
  wrapper.stderr.setEncoding('utf8');
  wrapper.stderr.on('data', chunk => { errors += chunk; });
  t.after(() => wrapper.kill('SIGTERM'));
  const next = nextLine(wrapper.stdout);
  const send = value => wrapper.stdin.write(`${JSON.stringify(value)}\n`);
  return { mcp: wrapper, next, send, errors: () => errors };
}

test('Codex continuation rollout reclaims its canonical identity and retires the prior bridge', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codex-reconnect-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'birds');
  const rollouts = path.join(root, 'rollouts');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(rollouts, { recursive: true });
  const { port, observer } = await startRelay(t, root);

  const oldSession = '11111111-1111-4111-8111-111111111111';
  const currentSession = '22222222-2222-4222-8222-222222222222';
  const oldRollout = path.join(rollouts,
    `rollout-2026-08-19T20-30-55-${oldSession}.jsonl`);
  const currentRollout = path.join(rollouts,
    `rollout-2026-08-21T18-09-30-${currentSession}.jsonl`);
  fs.writeFileSync(oldRollout,
    `${JSON.stringify({ type: 'session_meta', payload: { id: oldSession } })}\n`);
  fs.writeFileSync(currentRollout, [
    JSON.stringify({ type: 'session_meta', payload: { id: currentSession } }),
    JSON.stringify({ type: 'session_meta', payload: { id: oldSession } })
  ].join('\n'));
  const now = Date.now() / 1000;
  fs.utimesSync(oldRollout, now - 60, now - 60);
  fs.utimesSync(currentRollout, now, now);

  const joined = wsMessage(observer,
    message => message.type === 'peer_joined' && message.clientId === 'CODEX1');
  const mcp = startCodexContinuation(t, {
    root, port, cwd: project, oldRollout, currentRollout, oldSession
  });
  mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await mcp.next(message => message.id === 1);
  await joined;

  const relayed = wsMessage(observer,
    message => message.type === 'message' && message.content === 'continuation');
  mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'relay_send', arguments: { to: 'OBSERVER', message: 'continuation' }
  }});
  await mcp.next(message => message.id === 2);
  assert.equal((await relayed).from, 'CODEX1');

  const registry = JSON.parse(fs.readFileSync(
    path.join(root, 'claude-relay', 'sessions', 'registry.json'), 'utf8'));
  assert.equal(registry.CODEX1.source, 'codex-reconnect');
  assert.equal(registry.CODEX1.codexSessionId, currentSession);
  assert.equal(registry.CODEX6, undefined);
  assert.match(mcp.errors(), /Codex MCP continuation resolved through rollout lineage to CODEX1/);
});

test('Claude Code reconnect reclaims the canonical identity from the same transcript lineage', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-claude-reconnect-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'birds');
  fs.mkdirSync(project, { recursive: true });
  const { port, observer } = await startRelay(t, root);

  const rootSession = '11111111-1111-4111-8111-111111111111';
  const currentSession = '22222222-2222-4222-8222-222222222222';
  // A real superseded bridge is blocked on MCP stdin before it receives a
  // replacement initialize. Starting the actual entry point (without sending
  // initialize) gives the reconnect guard the same argv/process shape while
  // keeping it disconnected from the relay.
  const predecessor = spawn(process.execPath, [path.join(__dirname, '..', 'mcp-server.js')], {
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: rootSession },
    stdio: ['pipe', 'ignore', 'ignore']
  });
  t.after(() => predecessor.kill('SIGTERM'));
  const sessions = path.join(root, 'claude-relay', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 'registry.json'), JSON.stringify({
    CC1: { pid: predecessor.pid, cwd: project, source: 'rename' }
  }));
  const transcriptDir = path.join(root, '.claude', 'projects', '-test-birds');
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptDir, `${currentSession}.jsonl`),
    `${JSON.stringify({ session_id: rootSession })}\n`);

  const joined = wsMessage(observer, message => message.type === 'peer_joined' && message.clientId === 'CC1');
  const predecessorExited = new Promise(resolve => predecessor.once('exit', resolve));
  const mcp = startMcp(t, {
    root, port, cwd: project,
    env: {
      CLAUDE_RELAY_SESSION_ID: 'CC2',
      CLAUDE_CODE_SESSION_ID: currentSession,
      CLAUDE_CODE_BRIDGE_SESSION_ID: 'session_test_reconnect',
      CLAUDE_PROJECT_DIR: project,
      RELAY_BACKGROUND_FORK: '1'
    }
  });
  mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await mcp.next(message => message.id === 1);
  await joined;

  const relayed = wsMessage(observer, message => message.type === 'message' && message.content === 'canonical');
  mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'relay_send', arguments: { to: 'OBSERVER', message: 'canonical' }
  }});
  assert.match((await mcp.next(message => message.id === 2)).result.content[0].text, /Sent to OBSERVER/);
  assert.equal((await relayed).from, 'CC1');
  const meta = await waitForSessionMeta(observer, 'CC1', value => value.relayUsage?.calls >= 1);
  assert.equal(meta.toolProfile, 'claude-core');
  assert.equal(meta.relayUsage.byTool.relay_send, 1);
  assert.ok(meta.relayUsage.resultBytes > 0);
  await predecessorExited;
});

test('ordinary background work cannot steal a matching foreground transcript identity', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-claude-background-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'birds');
  fs.mkdirSync(project, { recursive: true });
  const { port, observer } = await startRelay(t, root);

  const rootSession = '33333333-3333-4333-8333-333333333333';
  const currentSession = '44444444-4444-4444-8444-444444444444';
  const predecessor = spawn(process.execPath, [path.join(__dirname, '..', 'mcp-server.js')], {
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: rootSession },
    stdio: ['pipe', 'ignore', 'ignore']
  });
  t.after(() => predecessor.kill('SIGTERM'));
  const sessions = path.join(root, 'claude-relay', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 'registry.json'), JSON.stringify({
    CC1: { pid: predecessor.pid, cwd: project, source: 'rename' }
  }));
  const transcriptDir = path.join(root, '.claude', 'projects', '-test-birds');
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptDir, `${currentSession}.jsonl`),
    `${JSON.stringify({ session_id: rootSession })}\n`);

  const joined = wsMessage(observer, message =>
    message.type === 'peer_joined' && /^CC2-bg[0-9a-z]+$/.test(message.clientId));
  const mcp = startMcp(t, {
    root, port, cwd: project,
    env: {
      CLAUDE_RELAY_SESSION_ID: 'CC2',
      CLAUDE_CODE_SESSION_ID: currentSession,
      // Ordinary background work has no bridge token; never inherit the
      // token of a Claude session that happens to run this suite.
      CLAUDE_CODE_BRIDGE_SESSION_ID: '',
      CLAUDE_PROJECT_DIR: project,
      RELAY_BACKGROUND_FORK: '1'
    }
  });
  mcp.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await mcp.next(message => message.id === 1);
  const identity = (await joined).clientId;

  const relayed = wsMessage(observer, message => message.type === 'message' && message.content === 'background');
  mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'relay_send', arguments: { to: 'OBSERVER', message: 'background' }
  }});
  await mcp.next(message => message.id === 2);
  assert.equal((await relayed).from, identity);
  assert.equal(predecessor.exitCode, null);
});

test('unfiltered relay_receive resumes from its saved cursor after MCP restart', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cursor-reconnect-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  const { port, observer } = await startRelay(t, root);

  const firstJoined = wsMessage(observer, message => message.type === 'peer_joined' && message.clientId === 'CURSOR');
  const first = startMcp(t, { root, port, cwd: project, clientId: 'CURSOR' });
  first.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await first.next(message => message.id === 1);
  await firstJoined;
  const firstSent = wsMessage(observer, message => message.type === 'sent' && message.to === 'CURSOR');
  observer.send(JSON.stringify({ type: 'message', to: 'CURSOR', content: 'first' }));
  await firstSent;
  first.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'relay_receive', arguments: {}
  }});
  const initial = await first.next(message => message.id === 2);
  assert.match(initial.result.content[0].text, /first/);
  first.mcp.kill('SIGTERM');
  await wsMessage(observer, message => message.type === 'peer_left' && message.clientId === 'CURSOR');

  const secondSent = wsMessage(observer, message => message.type === 'sent' && message.to === 'CURSOR');
  observer.send(JSON.stringify({ type: 'message', to: 'CURSOR', content: 'second' }));
  await secondSent;
  const secondJoined = wsMessage(observer, message => message.type === 'peer_joined' && message.clientId === 'CURSOR');
  const second = startMcp(t, { root, port, cwd: project, clientId: 'CURSOR' });
  second.send({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} });
  await second.next(message => message.id === 3);
  await secondJoined;
  second.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
    name: 'relay_receive', arguments: {}
  }});
  const resumed = (await second.next(message => message.id === 4)).result.content[0].text;
  assert.match(resumed, /second/);
  assert.doesNotMatch(resumed, /first/);

  const cursorsFile = path.join(root, 'claude-relay', 'sessions', 'read-cursors.json');
  fs.writeFileSync(cursorsFile, JSON.stringify({
    CURSOR: { cursor: '00000000-0000-4000-8000-000000000000' }
  }));
  for (const id of [5, 6]) {
    second.send({ jsonrpc: '2.0', id, method: 'tools/call', params: {
      name: 'relay_receive', arguments: {}
    }});
    const pinned = (await second.next(message => message.id === id)).result.content[0].text;
    assert.match(pinned, /saved cursor was retained/);
    assert.match(pinned, /replay=true and no from\/to\/after filter/);
    assert.doesNotMatch(pinned, /first|second/);
  }
  second.send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: {
    name: 'relay_receive', arguments: { replay: true, to: 'CURSOR' }
  }});
  await second.next(message => message.id === 8);
  assert.equal(JSON.parse(fs.readFileSync(cursorsFile, 'utf8')).CURSOR.cursor,
    '00000000-0000-4000-8000-000000000000', 'filtered replay does not move the mailbox cursor');
  second.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: {
    name: 'relay_receive', arguments: { replay: true }
  }});
  const replayed = (await second.next(message => message.id === 7)).result.content[0].text;
  assert.match(replayed, /first/);
  assert.match(replayed, /second/);
  assert.notEqual(JSON.parse(fs.readFileSync(cursorsFile, 'utf8')).CURSOR.cursor,
    '00000000-0000-4000-8000-000000000000');
});

// td-49c1df: a label set with relay_rename is never the configured base ID,
// so a replacement bridge used to come back under the hostname-pid default.
function claudeEnv(session, extra = {}) {
  return {
    CLAUDE_RELAY_SESSION_ID: '',
    CLAUDE_CODE_BRIDGE_SESSION_ID: '',
    RELAY_BACKGROUND_FORK: '',
    CLAUDE_CODE_SESSION_ID: session,
    ...extra
  };
}

async function callTool(bridge, id, name, args = {}) {
  bridge.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  return (await bridge.next(message => message.id === id)).result.content[0].text;
}

async function initialized(bridge) {
  bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await bridge.next(message => message.id === 1);
  return bridge;
}

async function registeredStatus(bridge, firstId) {
  for (let id = firstId; id < firstId + 50; id += 1) {
    const status = await callTool(bridge, id, 'relay_status');
    if (/^Connected to /.test(status)) return status;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('bridge never registered');
}

// A bridge whose parent is NOT this test process (as when Claude Code's
// /mcp reconnect spawns it from a background host).
function startWrappedMcp(t, { root, port, cwd, env = {} }) {
  const wrapped = spawn('/bin/sh', ['-c', '"$0" "$@"; :', process.execPath,
    path.join(__dirname, '..', 'mcp-server.js'), `--relay-url=ws://127.0.0.1:${port}`], {
    cwd,
    env: { ...process.env, HOME: root, RELAY_CLIENT_ID: '', ...env },
    stdio: ['pipe', 'pipe', 'ignore']
  });
  t.after(() => wrapped.kill('SIGTERM'));
  return {
    mcp: wrapped,
    next: nextLine(wrapped.stdout),
    send: value => wrapped.stdin.write(`${JSON.stringify(value)}\n`)
  };
}

async function stopBridge(bridge) {
  const exited = new Promise(resolve => bridge.mcp.once('exit', resolve));
  bridge.mcp.kill('SIGTERM');
  await exited;
}

const autoLabel = new RegExp(`^${os.hostname().split('.')[0].toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[0-9a-z]+$`);

test('a runtime-renamed label survives an MCP restart in the same Claude session', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-rename-reconnect-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'birds');
  fs.mkdirSync(project, { recursive: true });
  const { port, observer } = await startRelay(t, root);
  const env = claudeEnv('55555555-5555-4555-8555-555555555555');

  const firstJoined = wsMessage(observer, message => message.type === 'peer_joined' && autoLabel.test(message.clientId));
  const first = await initialized(startMcp(t, { root, port, cwd: project, env }));
  await firstJoined;
  assert.match(await callTool(first, 2, 'relay_rename', { to: 'CC9' }), /confirmed by the relay server/);
  const sent = wsMessage(observer, message => message.type === 'sent' && message.to === 'CC9');
  observer.send(JSON.stringify({ type: 'message', to: 'CC9', content: 'read before reconnect' }));
  await sent;
  assert.match(await callTool(first, 3, 'relay_receive'), /read before reconnect/);
  await stopBridge(first);

  const joined = wsMessage(observer, message => message.type === 'peer_joined' && message.clientId === 'CC9');
  const second = await initialized(startMcp(t, { root, port, cwd: project, env }));
  await joined;
  assert.match(await registeredStatus(second, 2), /as "CC9"/);
  const resumed = await callTool(second, 60, 'relay_receive');
  assert.match(resumed, /No messages in history/);
  assert.doesNotMatch(resumed, /cursor was not found/);

  const registry = JSON.parse(fs.readFileSync(path.join(root, 'claude-relay', 'sessions', 'registry.json'), 'utf8'));
  assert.equal(registry.CC9.source, 'claude-session');
  assert.deepEqual(Object.keys(registry).filter(id => autoLabel.test(id)), [], 'no orphan default label');

  const later = wsMessage(observer, message => message.type === 'sent' && message.to === 'CC9');
  observer.send(JSON.stringify({ type: 'message', to: 'CC9', content: 'after reconnect' }));
  await later;
  assert.match(await callTool(second, 61, 'relay_receive'), /after reconnect/);
});

test('another Claude session never inherits a runtime-renamed label', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-rename-isolation-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'birds');
  fs.mkdirSync(project, { recursive: true });
  const { port, observer } = await startRelay(t, root);
  const session = '66666666-6666-4666-8666-666666666666';

  const ownerJoined = wsMessage(observer, message => message.type === 'peer_joined' && autoLabel.test(message.clientId));
  const owner = await initialized(startMcp(t, { root, port, cwd: project, env: claudeEnv(session) }));
  await ownerJoined;
  assert.match(await callTool(owner, 2, 'relay_rename', { to: 'CCOWN' }), /confirmed/);
  await stopBridge(owner);

  // Same parent process and cwd, different Claude session.
  const other = await initialized(startMcp(t, {
    root, port, cwd: project, env: claudeEnv('77777777-7777-4777-8777-777777777777')
  }));
  assert.match(await registeredStatus(other, 2), new RegExp(`as "${autoLabel.source.slice(1, -1)}"`));
  await stopBridge(other);

  // Same Claude session id, but served by a different parent process.
  const foreign = await initialized(startWrappedMcp(t, { root, port, cwd: project, env: claudeEnv(session) }));
  assert.match(await registeredStatus(foreign, 2), new RegExp(`as "${autoLabel.source.slice(1, -1)}"`));
});

test('two dead labels claiming the same Claude session fail closed', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-rename-ambiguous-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'birds');
  fs.mkdirSync(project, { recursive: true });
  const { port } = await startRelay(t, root);
  const parentStarted = require('child_process')
    .execSync(`ps -o lstart= -p ${process.pid}`, { encoding: 'utf8' }).trim();
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise(resolve => dead.once('exit', resolve));
  const entry = { pid: dead.pid, cwd: project, source: 'rename', parentPid: process.pid, parentStarted };
  const sessions = path.join(root, 'claude-relay', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 'registry.json'), JSON.stringify({ CCA: entry, CCB: entry }));

  const bridge = await initialized(startMcp(t, {
    root, port, cwd: project, env: claudeEnv('88888888-8888-4888-8888-888888888888')
  }));
  assert.match(await registeredStatus(bridge, 2), new RegExp(`as "${autoLabel.source.slice(1, -1)}"`));
  assert.match(bridge.errors(), /Several registry labels match this Claude session \(CCA, CCB\)/);
});

for (const token of ['session_same_bridge', 'session_other_bridge']) {
  test(`/mcp reconnect from a background host after the bridge died: ${token === 'session_same_bridge' ? 'same bridge token reclaims' : 'other bridge token does not reclaim'}`, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-dead-reconnect-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const project = path.join(root, 'birds');
    fs.mkdirSync(project, { recursive: true });
    const { port, observer } = await startRelay(t, root);
    const rootSession = '99999999-9999-4999-8999-999999999999';
    const currentSession = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const transcriptDir = path.join(root, '.claude', 'projects', '-test-birds');
    fs.mkdirSync(transcriptDir, { recursive: true });
    fs.writeFileSync(path.join(transcriptDir, `${currentSession}.jsonl`),
      `${JSON.stringify({ session_id: rootSession })}\n`);

    const joined = wsMessage(observer, message => message.type === 'peer_joined' && autoLabel.test(message.clientId));
    const first = await initialized(startMcp(t, { root, port, cwd: project, env: claudeEnv(rootSession, {
      CLAUDE_CODE_BRIDGE_SESSION_ID: 'session_same_bridge', CLAUDE_PROJECT_DIR: project
    }) }));
    await joined;
    assert.match(await callTool(first, 2, 'relay_rename', { to: 'CC7' }), /confirmed/);
    const sent = wsMessage(observer, message => message.type === 'sent' && message.to === 'CC7');
    observer.send(JSON.stringify({ type: 'message', to: 'CC7', content: 'read before reconnect' }));
    await sent;
    assert.match(await callTool(first, 3, 'relay_receive'), /read before reconnect/);
    await stopBridge(first);

    // The replacement looks like background work (different parent, fork
    // marker, inherited foreign CLAUDE_RELAY_SESSION_ID) and its transcript
    // is a continuation of the original root.
    const replacement = await initialized(startWrappedMcp(t, { root, port, cwd: project, env: claudeEnv(currentSession, {
      CLAUDE_RELAY_SESSION_ID: 'CC2',
      CLAUDE_CODE_BRIDGE_SESSION_ID: token,
      CLAUDE_PROJECT_DIR: project,
      RELAY_BACKGROUND_FORK: '1'
    }) }));
    const status = await registeredStatus(replacement, 2);
    if (token === 'session_same_bridge') {
      assert.match(status, /as "CC7"/);
      const resumed = await callTool(replacement, 60, 'relay_receive');
      assert.match(resumed, /No messages in history/);
      assert.doesNotMatch(resumed, /cursor was not found/);
    } else {
      assert.match(status, /as "CC2-bg[0-9a-z]+"/);
    }
  });
}

test('two live Claude sessions in one cwd each keep their runtime label across reconnects', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-rename-concurrent-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'birds');
  fs.mkdirSync(project, { recursive: true });
  const { port, observer } = await startRelay(t, root);
  const sessions = {
    CCA: claudeEnv('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    CCB: claudeEnv('cccccccc-cccc-4ccc-8ccc-cccccccccccc')
  };
  const bridges = {};
  for (const [label, env] of Object.entries(sessions)) {
    const joined = wsMessage(observer, message => message.type === 'peer_joined' && autoLabel.test(message.clientId));
    bridges[label] = await initialized(startMcp(t, { root, port, cwd: project, env }));
    await joined;
    assert.match(await callTool(bridges[label], 2, 'relay_rename', { to: label }), /confirmed/);
  }
  // Each reconnects while the other stays live.
  for (const label of ['CCA', 'CCB']) {
    await stopBridge(bridges[label]);
    bridges[label] = await initialized(startMcp(t, { root, port, cwd: project, env: sessions[label] }));
    assert.match(await registeredStatus(bridges[label], 2), new RegExp(`as "${label}"`));
  }
  assert.match(await registeredStatus(bridges.CCA, 80), /as "CCA"/);
});
