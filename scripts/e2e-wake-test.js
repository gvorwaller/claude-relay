#!/usr/bin/env node
'use strict';

const { randomBytes } = require('crypto');
const WebSocket = require('ws');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const target = arg('--target');
const relayUrl = arg('--relay-url', process.env.CLAUDE_RELAY_URL || 'ws://127.0.0.1:9999');
const timeoutMs = Number(arg('--timeout-ms', '180000'));
const expected = arg('--expect', `WAKE_E2E_OK_${randomBytes(4).toString('hex')}`);
const clientId = `WAKE-E2E-watch-${process.pid}-${randomBytes(4).toString('hex')}`;

if (!target || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(target)) {
  console.error('Usage: e2e-wake-test.js --target ID [--relay-url URL] [--timeout-ms MS] [--expect TOKEN]');
  process.exit(64);
}
if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
  console.error('--timeout-ms must be at least 1000');
  process.exit(64);
}

const ws = new WebSocket(relayUrl);
let ownerSecret = null;
let finished = false;
let exitStarted = false;
let cleanupTimer = null;
let exitCode = 2;
let exitMessage = 'E2E test timed out';

const timer = setTimeout(() => finish(2, 'E2E test timed out'), timeoutMs);

function closeAndExit() {
  if (exitStarted) return;
  exitStarted = true;
  clearTimeout(timer);
  clearTimeout(cleanupTimer);
  const code = exitCode;
  const message = exitMessage;
  let exited = false;
  const done = () => {
    if (exited) return;
    exited = true;
    if (message) (code === 0 ? console.log : console.error)(message);
    process.exit(code);
  };
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.once('close', done);
    ws.close();
    setTimeout(() => {
      try { ws.terminate(); } catch {}
      done();
    }, 1000).unref();
  } else {
    done();
  }
}

function finish(code, message) {
  if (finished) return;
  finished = true;
  exitCode = code;
  exitMessage = message;
  if (ownerSecret && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'discard_enrollment',
      clientId,
      ownerSecret
    }));
    cleanupTimer = setTimeout(() => {
      ownerSecret = null;
      if (exitCode === 0) exitCode = 5;
      exitMessage = `Enrollment cleanup timed out for ${clientId}`;
      closeAndExit();
    }, 3000);
    return;
  }
  closeAndExit();
}

ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'register',
    clientId,
    meta: { pid: process.pid, cwd: process.cwd(), source: 'wake-e2e-test' }
  }));
});

ws.on('message', data => {
  let message;
  try { message = JSON.parse(data); } catch { return; }
  if (message.type === 'registered' && !ownerSecret) {
    ownerSecret = message.ownerSecret || null;
    if (!ownerSecret) {
      finish(3, `Relay did not mint a disposable owner secret for ${clientId}`);
      return;
    }
    ws.send(JSON.stringify({
      type: 'message',
      to: target,
      content: `Automated delegate E2E test from ${clientId}. Reply with the exact token ${expected}, then end your turn.`
    }));
    return;
  }
  if (message.type === 'message' && message.from === target) {
    const body = String(message.content || '').trim();
    finish(body === expected ? 0 : 3,
      body === expected
        ? `E2E wake succeeded: ${target} replied ${expected}; ${clientId} enrollment discarded.`
        : `Unexpected reply from ${target}: ${body}`);
    return;
  }
  if (message.type === 'enrollment_discarded' && message.clientId === clientId) {
    clearTimeout(cleanupTimer);
    ownerSecret = null;
    closeAndExit();
    return;
  }
  if (message.type === 'error') {
    if (finished) {
      ownerSecret = null;
      exitCode = 4;
      exitMessage = `Enrollment cleanup failed: ${message.message}`;
      closeAndExit();
    } else {
      finish(4, `Relay error: ${message.message}`);
    }
  }
});

ws.on('error', error => finish(4, `Relay connection failed: ${error.message}`));
ws.on('close', () => {
  if (!finished) finish(4, 'Relay connection closed before the E2E test completed');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => finish(130, `E2E test interrupted by ${signal}`));
}
