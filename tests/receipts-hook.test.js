const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');

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

function connect(port, clientId, meta) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('error', reject);
    ws.once('open', () => {
      ws.on('message', data => {
        const msg = JSON.parse(data);
        if (msg.type === 'registered') resolve({ ws, ownerSecret: msg.ownerSecret });
      });
      ws.send(JSON.stringify({ type: 'register', clientId, ...(meta ? { meta } : {}) }));
    });
  });
}

async function connectWithRetry(port, clientId, meta) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await connect(port, clientId, meta);
    } catch {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  throw new Error('server did not start');
}

function runHook(event, input, env) {
  return JSON.parse(execFileSync(
    process.execPath,
    [path.join(__dirname, '..', 'scripts', 'relay-receipts-hook.js'), '--event', event],
    { input: JSON.stringify(input), encoding: 'utf8', env, timeout: 15000 }
  ) || '{}');
}

test('the hook pair injects receipts, blocks an unreported turn, then closes them out', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-hook-')));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, 'claude-relay', 'sessions', 'owners'), { recursive: true });
  // The server loads its job store at startup, so the finished delegate work
  // must exist before it boots (in production the server creates these
  // itself, from its own notify path).
  const { DelegateJobStore } = require('../delegate-job-store');
  const store = new DelegateJobStore({ dataDir: path.join(root, 'jobs') }).initialize();
  const job = store.create({ owner: 'HOOKOWNER', inboundMessageId: 'in-1', from: 'CC6' });
  store.transition(job.jobId, 'running', { spawnPid: process.pid });
  store.recordOutbound(job.jobId, { to: 'CC6', messageId: 'msg-42', delivered: true });
  store.attachResult(job.jobId, { summary: 'Reviewed the branch.', changes: 'No files changed.', verification: ['83/83'] });
  store.transition(job.jobId, 'completed');

  const port = startServer(t, root, { RELAY_MESSAGE_DIR: path.join(root, 'messages') });

  // A session owns HOOKOWNER and receives its capability; the hook reads
  // that capability from disk rather than registering a label of its own.
  const owner = await connectWithRetry(port, 'HOOKOWNER', { pid: process.pid });
  t.after(() => owner.ws.close());
  assert.ok(owner.ownerSecret, 'owner capability issued');
  fs.writeFileSync(
    path.join(home, 'claude-relay', 'sessions', 'owners', 'HOOKOWNER.secret'),
    owner.ownerSecret,
    { mode: 0o600 }
  );

  const env = {
    ...process.env,
    HOME: home,
    RELAY_URL: `ws://127.0.0.1:${port}`,
    RELAY_DELEGATE_FOR: '',
    RELAY_RECEIPTS_OWNER: 'HOOKOWNER'
  };

  // Phase 1: injection carries the server-attested facts and the marker.
  const injected = runHook('UserPromptSubmit', { session_id: 's1' }, env);
  const context = injected.hookSpecificOutput && injected.hookSpecificOutput.additionalContext;
  assert.ok(context, 'pending receipts are injected');
  assert.match(context, /Reviewed the branch\./);
  assert.match(context, /SERVER-ATTESTED: replied to CC6, message msg-42, delivered live/);
  const digest = context.match(/relay-delegate-receipts: ([0-9a-f]{64})/)[1];
  const reportLine = 'Background delegate woken by CC6: completed; relay replies: CC6 (delivered live).';
  assert.match(context, new RegExp(reportLine.replace(/[().]/g, '\\$&')));

  // Injection alone must NOT mark it reported.
  const midCheck = new DelegateJobStore({ dataDir: path.join(root, 'jobs') }).initialize();
  assert.equal(midCheck.pending('HOOKOWNER').length, 1, 'injection is not display');

  // Phase 2a: a turn that ignores the receipt is blocked.
  const blocked = runHook('Stop', {
    session_id: 's1',
    last_assistant_message: 'Here is an answer that says nothing about the delegate.'
  }, env);
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /have not visibly reported 1 delegated run/);

  // Phase 2b: a turn that reports it is allowed, and the receipt closes.
  const accepted = runHook('Stop', {
    session_id: 's1',
    turn_id: 'turn-77',
    stop_hook_active: true,
    last_assistant_message:
      `${reportLine}\n\n<!-- relay-delegate-receipts: ${digest} -->`
  }, env);
  assert.ok(!accepted.decision, 'a reported turn is not blocked');

  const reopened = new DelegateJobStore({ dataDir: path.join(root, 'jobs') }).initialize();
  const closed = reopened.get(job.jobId);
  assert.equal(closed.status, 'reported');
  assert.equal(closed.reportedTurnId, 'turn-77');
  assert.equal(reopened.pending('HOOKOWNER').length, 0);
});
