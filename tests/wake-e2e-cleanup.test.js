'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

function waitForMessage(ws, predicate, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for message')), timeout);
    const handler = raw => {
      const message = JSON.parse(raw);
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off('message', handler);
      resolve(message);
    };
    ws.on('message', handler);
  });
}

async function connectWithRetry(port, clientId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      const registered = waitForMessage(ws, message => message.type === 'registered');
      ws.send(JSON.stringify({ type: 'register', clientId }));
      await registered;
      return ws;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  throw new Error('relay server did not start');
}

test('live wake E2E helper discards its synthetic owner enrollment', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wake-e2e-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), String(port)], {
    env: {
      ...process.env,
      RELAY_MESSAGE_DIR: path.join(root, 'messages'),
      RELAY_LOG_DIR: path.join(root, 'logs'),
      RELAY_DISABLE_NOTIFICATIONS: '1'
    },
    stdio: 'ignore'
  });
  t.after(() => server.kill('SIGTERM'));

  const target = await connectWithRetry(port, 'E2E-TARGET');
  t.after(() => target.close());
  target.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.type !== 'message' || !message.from.startsWith('WAKE-E2E-watch-')) return;
    const token = String(message.content).match(/exact token ([A-Za-z0-9_-]+)/)?.[1];
    target.send(JSON.stringify({ type: 'message', to: message.from, content: token }));
  });

  const helper = spawn(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'e2e-wake-test.js'),
    '--target', 'E2E-TARGET',
    '--relay-url', `ws://127.0.0.1:${port}`,
    '--timeout-ms', '5000',
    '--expect', 'TEST_WAKE_OK'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const result = await new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    helper.stdout.on('data', chunk => { stdout += chunk; });
    helper.stderr.on('data', chunk => { stderr += chunk; });
    helper.once('exit', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /enrollment discarded/);

  const owners = JSON.parse(fs.readFileSync(path.join(root, 'owners.json'), 'utf8'));
  assert.deepEqual(Object.keys(owners).filter(label => label.startsWith('WAKE-E2E-')), []);
  assert.equal(Boolean(owners['E2E-TARGET']), true, 'real target identity remains enrolled');
});
