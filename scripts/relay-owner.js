#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const args = process.argv.slice(2);
const command = args[0];
const label = args[1];
const value = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
if (command !== 'rotate' || !label) {
  console.error('Usage: relay-owner rotate LABEL [--force] [--data-dir DIR] [--relay-url URL]');
  process.exit(2);
}
const dataRoot = value('--data-dir') || path.join(__dirname, '..', 'data');
const relayUrl = value('--relay-url') || process.env.RELAY_URL || 'ws://127.0.0.1:9999';
let adminSecret;
try {
  adminSecret = fs.readFileSync(path.join(dataRoot, 'admin.secret'), 'utf8').trim();
} catch (err) {
  console.error(`Cannot read local relay admin capability: ${err.message}`);
  process.exit(1);
}

const ws = new WebSocket(relayUrl);
const timer = setTimeout(() => {
  console.error('Timed out waiting for owner rotation');
  ws.terminate();
  process.exit(1);
}, 10000);
ws.on('open', () => ws.send(JSON.stringify({
  type: 'rotate_owner', clientId: label, adminSecret, force: args.includes('--force')
})));
ws.on('message', data => {
  const message = JSON.parse(data.toString());
  if (message.type === 'owner_rotated') {
    clearTimeout(timer);
    console.log(`Rotated ${message.clientId} to generation ${message.generation}`);
    console.log(`Secret file: ${message.secretPath}`);
    ws.close();
    return;
  }
  if (message.type === 'owner_rotation_refused' || message.type === 'error') {
    clearTimeout(timer);
    console.error(message.reason || message.message);
    ws.close();
    process.exitCode = 1;
  }
});
ws.on('error', err => {
  clearTimeout(timer);
  console.error(`Owner rotation failed: ${err.message}`);
  process.exitCode = 1;
});
