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

function startServer(t, root) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), String(port)], {
    env: {
      ...process.env,
      RELAY_MESSAGE_DIR: path.join(root, 'messages'),
      RELAY_LOG_DIR: path.join(root, 'logs')
    },
    stdio: 'ignore'
  });
  t.after(() => child.kill('SIGTERM'));
  return port;
}

async function connectWithRetry(port, clientId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await connect(port, clientId);
    } catch {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  throw new Error('relay server did not start');
}

function mcpLines(stream) {
  let buffer = '';
  const waiting = [];
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const value = JSON.parse(line);
      const match = waiting.find(entry => entry.predicate(value));
      if (match) {
        waiting.splice(waiting.indexOf(match), 1);
        clearTimeout(match.timer);
        match.resolve(value);
      }
    }
  });
  return predicate => new Promise((resolve, reject) => {
    const entry = { predicate, resolve };
    entry.timer = setTimeout(() => {
      waiting.splice(waiting.indexOf(entry), 1);
      reject(new Error('Timed out waiting for MCP response'));
    }, 3000);
    waiting.push(entry);
  });
}

test('server treats same-socket re-register as a rename and drops the old identity', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-rename-server-'));
  const port = startServer(t, root);

  const renamer = await connectWithRetry(port, 'WRONG');
  const peer = await connect(port, 'PEER');
  t.after(() => [renamer, peer].forEach(ws => ws.close()));

  // Re-register the same socket under the corrected identity.
  const left = waitForMessage(peer, msg => msg.type === 'peer_left' && msg.clientId === 'WRONG');
  const joined = waitForMessage(peer, msg => msg.type === 'peer_joined' && msg.clientId === 'RIGHT1');
  const reRegistered = waitForMessage(renamer, msg => msg.type === 'registered' && msg.clientId === 'RIGHT1');
  renamer.send(JSON.stringify({ type: 'register', clientId: 'RIGHT1' }));
  await Promise.all([left, joined, reRegistered]);

  // Peer's view: only the new identity remains.
  const peersMsg = waitForMessage(peer, msg => msg.type === 'peers');
  peer.send(JSON.stringify({ type: 'get_peers' }));
  const peersList = (await peersMsg).peers;
  assert.ok(peersList.includes('RIGHT1'), 'renamed identity is live');
  assert.ok(!peersList.includes('WRONG'), 'old identity is fully released');

  // Messages route to the new identity...
  const delivered = waitForMessage(renamer, msg => msg.type === 'message' && msg.content === 'hello new name');
  peer.send(JSON.stringify({ type: 'message', to: 'RIGHT1', content: 'hello new name' }));
  await delivered;

  // ...and the old identity is gone, not a zombie that eats messages.
  const rejected = waitForMessage(peer, msg => msg.type === 'error' && /WRONG not connected/.test(msg.message));
  peer.send(JSON.stringify({ type: 'message', to: 'WRONG', content: 'nobody home' }));
  await rejected;
});

test('relay_rename corrects a live MCP session identity without restart', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-rename-mcp-'));
  const port = startServer(t, root);

  const peer = await connectWithRetry(port, 'OBSERVER');
  t.after(() => peer.close());

  // Simulate the Codex failure mode: fixed RELAY_CLIENT_ID, cwd that matches
  // nothing in the registry, so the session comes up under the wrong name.
  const joinedWrong = waitForMessage(peer, msg => msg.type === 'peer_joined' && msg.clientId === 'CODEXTEST');
  const mcp = spawn(process.execPath, [path.join(__dirname, '..', 'mcp-server.js'), `--relay-url=ws://127.0.0.1:${port}`], {
    env: {
      ...process.env,
      HOME: root,
      CLAUDE_RELAY_SESSION_ID: '',
      RELAY_CLIENT_ID: 'CODEXTEST'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => mcp.kill('SIGTERM'));
  const next = mcpLines(mcp.stdout);
  const send = value => mcp.stdin.write(`${JSON.stringify(value)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await next(msg => msg.id === 1);
  await joinedWrong;

  // Invalid target is rejected without touching anything.
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'relay_rename', arguments: { to: '1 bad id!' }
  }});
  const invalid = await next(msg => msg.id === 2);
  assert.match(invalid.result.content[0].text, /invalid session ID/);

  // The live session renames itself — no restart, no env vars.
  const leftWrong = waitForMessage(peer, msg => msg.type === 'peer_left' && msg.clientId === 'CODEXTEST');
  const joinedRight = waitForMessage(peer, msg => msg.type === 'peer_joined' && msg.clientId === 'CODEXTEST1');
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
    name: 'relay_rename', arguments: { to: 'CODEXTEST1' }
  }});
  const renamed = await next(msg => msg.id === 3);
  assert.match(renamed.result.content[0].text, /CODEXTEST → CODEXTEST1/);
  assert.match(renamed.result.content[0].text, /old ID was released/);
  await Promise.all([leftWrong, joinedRight]);

  // relay_status reports the corrected identity.
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'relay_status', arguments: {} } });
  const status = await next(msg => msg.id === 4);
  assert.match(status.result.content[0].text, /as "CODEXTEST1"/);

  // Local registry now holds the corrected identity only.
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'claude-relay', 'sessions', 'registry.json'), 'utf8'));
  assert.ok(registry.CODEXTEST1, 'new identity registered locally');
  assert.equal(registry.CODEXTEST1.source, 'rename');
  assert.ok(!registry.CODEXTEST, 'old identity removed from local registry');

  // Messages addressed to the corrected identity reach the renamed session.
  peer.send(JSON.stringify({ type: 'message', to: 'CODEXTEST1', content: 'review request' }));
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: {
    name: 'relay_wait', arguments: { from: 'OBSERVER', timeoutSeconds: 2 }
  }});
  const waited = await next(msg => msg.id === 5);
  assert.match(waited.result.content[0].text, /OBSERVER: review request/);
});
