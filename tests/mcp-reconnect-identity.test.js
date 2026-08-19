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
    assert.doesNotMatch(pinned, /first|second/);
  }
  second.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: {
    name: 'relay_receive', arguments: { replay: true }
  }});
  const replayed = (await second.next(message => message.id === 7)).result.content[0].text;
  assert.match(replayed, /first/);
  assert.match(replayed, /second/);
  assert.notEqual(JSON.parse(fs.readFileSync(cursorsFile, 'utf8')).CURSOR.cursor,
    '00000000-0000-4000-8000-000000000000');
});
