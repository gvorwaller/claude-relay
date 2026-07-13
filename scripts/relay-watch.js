#!/usr/bin/env node
'use strict';

const WebSocket = require('ws');
const { randomUUID } = require('crypto');

const args = process.argv.slice(2);
function value(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const target = value('--for');
const relayUrl = value('--relay-url', process.env.RELAY_URL || 'ws://localhost:9999');
const timeoutSeconds = Math.max(1, Math.min(Number(value('--timeout', '240')) || 240, 300));

if (!target) {
  console.error('Usage: relay-watch.js --for CLIENT_ID [--timeout 240] [--relay-url ws://localhost:9999]');
  process.exit(2);
}

const watcherId = `${target}-watch-${process.pid}-${randomUUID().slice(0, 8)}`;
const ws = new WebSocket(relayUrl);
let finished = false;

function finish(output, code) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  console.log(output);
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  process.exitCode = code;
}

const timer = setTimeout(() => finish('timeout', 0), timeoutSeconds * 1000);

ws.on('open', () => ws.send(JSON.stringify({
  type: 'register',
  clientId: watcherId,
  meta: { source: 'relay-watch', pid: process.pid }
})));

ws.on('message', data => {
  const message = JSON.parse(data.toString());
  if (message.type === 'registered') {
    ws.send(JSON.stringify({ type: 'watch', for: target }));
  } else if (message.type === 'new_message' && message.for === target) {
    finish('new-message', 0);
  } else if (message.type === 'error') {
    finish(`error: ${message.message}`, 2);
  }
});

ws.on('error', error => finish(`error: ${error.message}`, 2));
ws.on('close', () => {
  if (!finished) finish('error: relay disconnected', 2);
});
