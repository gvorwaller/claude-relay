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

test('server persists authorized history, preserves it on cache clear, and gates purge', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-server-'));
  const jobsDir = path.join(root, 'jobs');
  fs.mkdirSync(jobsDir);
  const terminalJobId = 'wake_11111111-1111-4111-8111-111111111111';
  const operatorJobId = 'wake_22222222-2222-4222-8222-222222222222';
  fs.writeFileSync(path.join(jobsDir, `${terminalJobId}.json`), JSON.stringify({
    jobId: terminalJobId,
    owner: 'CODEX1',
    status: 'completed',
    requestedAt: new Date().toISOString(),
    outbound: []
  }));
  fs.writeFileSync(path.join(jobsDir, `${operatorJobId}.json`), JSON.stringify({
    jobId: operatorJobId,
    owner: 'CODEX2',
    status: 'completed',
    requestedAt: new Date().toISOString(),
    outbound: []
  }));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), String(port)], {
    env: {
      ...process.env,
      NODE_PATH: path.join(__dirname, '..', 'node_modules'),
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
  const watcher = await connect(port, 'B-watch-test');
  t.after(() => [sender, recipient, outsider, admin, watcher].forEach(ws => ws.close()));

  const observer = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => {
    observer.once('open', resolve);
    observer.once('error', reject);
  });
  t.after(() => observer.close());
  observer.send(JSON.stringify({ type: 'get_peers' }));
  assert.deepEqual((await nextMessage(observer, 'peers')).peers.sort(),
    ['A', 'ADMIN', 'B', 'B-watch-test', 'C'].sort());
  observer.send(JSON.stringify({ type: 'get_sessions' }));
  assert.deepEqual(Object.keys((await nextMessage(observer, 'sessions')).sessions).sort(),
    ['A', 'ADMIN', 'B', 'B-watch-test', 'C'].sort());

  const watching = nextMessage(watcher, 'watching');
  watcher.send(JSON.stringify({ type: 'watch', for: 'B' }));
  assert.equal((await watching).for, 'B');

  const delivered = nextMessage(recipient, 'message');
  const doorbell = nextMessage(watcher, 'new_message');
  sender.send(JSON.stringify({ type: 'message', to: 'B', content: 'private review' }));
  assert.equal((await delivered).content, 'private review');
  const ping = await doorbell;
  assert.deepEqual(Object.keys(ping).sort(), ['at', 'for', 'type']);
  assert.equal(ping.for, 'B');

  const helperJoined = waitForMessage(sender, message =>
    message.type === 'peer_joined' && message.clientId.startsWith('C-watch-'));
  const helper = spawn(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'relay-watch.js'),
    '--for', 'C', '--timeout', '2', '--relay-url', `ws://127.0.0.1:${port}`
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => helper.kill('SIGTERM'));
  await helperJoined;
  // Registration precedes the watch request on one ordered WebSocket. Yield
  // once so the server can acknowledge the subscription before the message.
  await new Promise(resolve => setTimeout(resolve, 10));
  const helperOutput = new Promise((resolve, reject) => {
    let stdout = '';
    helper.stdout.on('data', chunk => { stdout += chunk; });
    helper.once('error', reject);
    helper.once('exit', code => resolve({ code, stdout: stdout.trim() }));
  });
  sender.send(JSON.stringify({ type: 'message', to: 'C', content: 'wake up' }));
  assert.deepEqual(await helperOutput, { code: 0, stdout: 'new-message' });

  recipient.send(JSON.stringify({ type: 'get_history', count: 10, from: 'A' }));
  const visible = await nextMessage(recipient, 'history');
  assert.equal(visible.messages.length, 1);
  assert.ok(visible.cursor);

  outsider.send(JSON.stringify({ type: 'get_history', count: 10, from: 'A' }));
  const outsiderHistory = await nextMessage(outsider, 'history');
  assert.deepEqual(outsiderHistory.messages.map(message => message.content), ['wake up']);
  assert.equal(outsiderHistory.messages.some(message => message.content === 'private review'), false);

  outsider.send(JSON.stringify({ type: 'purge_history' }));
  assert.equal((await nextMessage(outsider, 'error')).message, 'Durable history purge is not authorized');

  outsider.send(JSON.stringify({ type: 'preview_delegate_jobs', owner: 'CODEX1' }));
  assert.equal((await nextMessage(outsider, 'error')).message, 'Delegate-job administration is not authorized');

  admin.send(JSON.stringify({ type: 'preview_delegate_jobs', owner: 'CODEX1' }));
  const preview = await nextMessage(admin, 'delegate_jobs_preview');
  assert.equal(preview.count, 1);
  admin.send(JSON.stringify({
    type: 'purge_delegate_jobs', owner: 'CODEX1', confirmation: 'wrong'
  }));
  assert.match((await nextMessage(admin, 'error')).message, /confirmation is invalid/);
  assert.ok(fs.existsSync(path.join(jobsDir, `${terminalJobId}.json`)));
  admin.send(JSON.stringify({
    type: 'purge_delegate_jobs', owner: 'CODEX1', confirmation: preview.confirmation
  }));
  assert.equal((await nextMessage(admin, 'delegate_jobs_purged')).purged, 1);
  assert.equal(fs.existsSync(path.join(jobsDir, `${terminalJobId}.json`)), false);

  const operator = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => {
    operator.once('open', resolve);
    operator.once('error', reject);
  });
  t.after(() => operator.close());
  operator.send(JSON.stringify({
    type: 'operator_preview_delegate_jobs', owner: 'CODEX2', adminSecret: 'wrong'
  }));
  assert.equal((await nextMessage(operator, 'error')).message, 'Operator action requires local admin authority');
  const localSecret = fs.readFileSync(path.join(root, 'admin.secret'), 'utf8').trim();
  operator.send(JSON.stringify({
    type: 'rotate_owner', clientId: 'REPAIR1', adminSecret: localSecret, force: true
  }));
  assert.equal((await nextMessage(operator, 'owner_rotated')).clientId, 'REPAIR1');
  assert.ok(fs.existsSync(path.join(root, 'owners', 'REPAIR1.secret')));
  operator.send(JSON.stringify({
    type: 'operator_preview_delegate_jobs', owner: 'CODEX2', adminSecret: localSecret
  }));
  const operatorPreview = await nextMessage(operator, 'delegate_jobs_preview');
  assert.equal(operatorPreview.count, 1);
  operator.send(JSON.stringify({
    type: 'operator_purge_delegate_jobs', owner: 'CODEX2',
    confirmation: operatorPreview.confirmation, adminSecret: localSecret
  }));
  assert.equal((await nextMessage(operator, 'delegate_jobs_purged')).purged, 1);
  assert.equal(fs.existsSync(path.join(jobsDir, `${operatorJobId}.json`)), false);

  admin.send(JSON.stringify({ type: 'purge_history' }));
  assert.equal((await nextMessage(admin, 'history_purged')).filesDeleted, 1);
});
