const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

function lines(stream) {
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

async function connect(port, id) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const registered = new Promise(resolve => ws.on('message', data => {
    const msg = JSON.parse(data);
    if (msg.type === 'registered') resolve();
  }));
  ws.send(JSON.stringify({ type: 'register', clientId: id }));
  await registered;
  return ws;
}

function wsMessage(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for relay message')), 3000);
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

test('relay_wait catches durable and pushed messages through MCP and rejects overlap', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mcp-wait-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = {
    ...process.env,
    RELAY_MESSAGE_DIR: path.join(root, 'messages'),
    RELAY_LOG_DIR: path.join(root, 'logs')
  };
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), String(port)], {
    env, stdio: 'ignore'
  });
  t.after(() => server.kill('SIGTERM'));

  let peer;
  for (let attempt = 0; attempt < 100 && !peer; attempt += 1) {
    try { peer = await connect(port, 'CC2'); } catch { await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  assert.ok(peer, 'relay server started');
  t.after(() => peer.close());

  peer.send(JSON.stringify({ type: 'message', to: 'CODEX-WAIT-TEST', content: 'durable' }));
  const persisted = wsMessage(peer, msg => msg.type === 'history' && msg.messages.some(item => item.content === 'durable'));
  peer.send(JSON.stringify({ type: 'get_history', count: 10 }));
  await persisted;
  const joined = wsMessage(peer, msg => msg.type === 'peer_joined' && msg.clientId === 'CODEX-WAIT-TEST');
  const mcp = spawn(process.execPath, [path.join(__dirname, '..', 'mcp-server.js'),
    '--client-id=CODEX-WAIT-TEST', `--relay-url=ws://127.0.0.1:${port}`], {
    env: { ...env, HOME: root, CLAUDE_RELAY_SESSION_ID: '', RELAY_CLIENT_ID: '' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let mcpErrors = '';
  mcp.stderr.setEncoding('utf8');
  mcp.stderr.on('data', chunk => { mcpErrors += chunk; });
  t.after(() => mcp.kill('SIGTERM'));
  const next = lines(mcp.stdout);
  const send = value => mcp.stdin.write(`${JSON.stringify(value)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await next(msg => msg.id === 1);
  await joined;

  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'relay_wait', arguments: { from: 'CC2', timeoutSeconds: 2 }
  }});
  const durable = await next(msg => msg.id === 2);
  assert.match(durable.result.content[0].text, /CC2: durable/, mcpErrors);
  const cursor = /Cursor: (\S+)/.exec(durable.result.content[0].text)[1];

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
    name: 'relay_wait', arguments: { from: 'CC2', after: cursor, timeoutSeconds: 2 }
  }});
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
    name: 'relay_wait', arguments: { from: 'CC2', after: cursor, timeoutSeconds: 2 }
  }});
  const overlap = await next(msg => msg.id === 4);
  assert.match(overlap.error.message, /already active/);
  peer.send(JSON.stringify({ type: 'message', to: 'CODEX-WAIT-TEST', content: 'pushed' }));
  const pushed = await next(msg => msg.id === 3);
  assert.match(pushed.result.content[0].text, /CC2: pushed/);
});

test('foreground relay_wait claims one message and suppresses duplicate watcher and exec wakes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mcp-claim-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const marker = path.join(root, 'exec-wake-fired');
  const notifyConfig = path.join(root, 'notify.json');
  fs.writeFileSync(notifyConfig, JSON.stringify({
    CLAIMED: [{ type: 'exec', command: `printf fired > "${marker}"` }]
  }));
  const env = {
    ...process.env,
    RELAY_MESSAGE_DIR: path.join(root, 'messages'),
    RELAY_LOG_DIR: path.join(root, 'logs'),
    RELAY_NOTIFY_CONFIG: notifyConfig
  };
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), String(port)], {
    env, stdio: 'ignore'
  });
  t.after(() => server.kill('SIGTERM'));

  let peer;
  for (let attempt = 0; attempt < 100 && !peer; attempt += 1) {
    try { peer = await connect(port, 'SENDER'); } catch { await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  assert.ok(peer);
  t.after(() => peer.close());
  const watcher = await connect(port, 'CLAIMED-watch-test');
  t.after(() => watcher.close());
  const watcherReady = wsMessage(watcher, msg => msg.type === 'watching');
  watcher.send(JSON.stringify({ type: 'watch', for: 'CLAIMED' }));
  await watcherReady;

  const joined = wsMessage(peer, msg => msg.type === 'peer_joined' && msg.clientId === 'CLAIMED');
  const mcp = spawn(process.execPath, [path.join(__dirname, '..', 'mcp-server.js'),
    '--client-id=CLAIMED', `--relay-url=ws://127.0.0.1:${port}`], {
    env: { ...env, HOME: root, CLAUDE_RELAY_SESSION_ID: '', RELAY_CLIENT_ID: '' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => mcp.kill('SIGTERM'));
  const next = lines(mcp.stdout);
  const send = value => mcp.stdin.write(`${JSON.stringify(value)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await next(msg => msg.id === 1);
  await joined;

  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'relay_wait', arguments: { from: 'SENDER', timeoutSeconds: 2 }
  }});
  // The history response proves the server accepted the attention claim and
  // the MCP bridge moved into its waiting state before the message is sent.
  await new Promise(resolve => setTimeout(resolve, 100));
  const claimed = wsMessage(watcher, msg => msg.type === 'message_claimed');
  peer.send(JSON.stringify({ type: 'message', to: 'CLAIMED', content: 'only once' }));
  const response = await next(msg => msg.id === 2);
  assert.match(response.result.content[0].text, /SENDER: only once/);
  assert.equal((await claimed).for, 'CLAIMED');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(fs.existsSync(marker), false, 'exec wake was suppressed');
});

test('relay-coordinate skill defines timeout loop and exact stop token', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'skills', 'relay-coordinate', 'SKILL.md'), 'utf8');
  assert.match(text, /RELAY_DONE/);
  assert.match(text, /normal timeout, call `relay_wait` again/);
  assert.match(text, /exact peer ID/);
  assert.match(text, /Never interrupt a\n   running command/);
});
