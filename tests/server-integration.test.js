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

test('server persists authorized history, preserves it on cache clear, and gates purge', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-server-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), String(port)], {
    env: {
      ...process.env,
      NODE_PATH: '/Users/gaylonvorwaller/claude-relay/node_modules',
      RELAY_MESSAGE_DIR: path.join(root, 'messages'),
      RELAY_LOG_DIR: path.join(root, 'logs'),
      RELAY_ADMIN_CLIENT_IDS: 'ADMIN'
    },
    stdio: 'ignore'
  });
  t.after(() => child.kill('SIGTERM'));

  let sender;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      sender = await connect(port, 'A');
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  assert.ok(sender, 'server started');
  const recipient = await connect(port, 'B');
  const outsider = await connect(port, 'C');
  const admin = await connect(port, 'ADMIN');
  t.after(() => [sender, recipient, outsider, admin].forEach(ws => ws.close()));

  const delivered = nextMessage(recipient, 'message');
  sender.send(JSON.stringify({ type: 'message', to: 'B', content: 'private review' }));
  assert.equal((await delivered).content, 'private review');

  recipient.send(JSON.stringify({ type: 'get_history', count: 10, from: 'A' }));
  const visible = await nextMessage(recipient, 'history');
  assert.equal(visible.messages.length, 1);
  assert.ok(visible.cursor);

  outsider.send(JSON.stringify({ type: 'get_history', count: 10, from: 'A' }));
  assert.equal((await nextMessage(outsider, 'history')).messages.length, 0);

  outsider.send(JSON.stringify({ type: 'purge_history' }));
  assert.equal((await nextMessage(outsider, 'error')).message, 'Durable history purge is not authorized');

  admin.send(JSON.stringify({ type: 'purge_history' }));
  assert.equal((await nextMessage(admin, 'history_purged')).filesDeleted, 1);
});
