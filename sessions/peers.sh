#!/bin/bash
# List currently connected Claude Relay peers (live, cluster-wide)
# Usage: ~/claude-relay/sessions/peers.sh

RELAY_ROOT="$HOME/claude-relay"
RELAY_URL="${RELAY_URL:-ws://localhost:9999}"

node -e "
const WebSocket = require('$RELAY_ROOT/node_modules/ws');
const ws = new WebSocket('$RELAY_URL');
const TIMEOUT_MS = 3000;

const timer = setTimeout(() => {
  console.error('Timed out waiting for relay server at $RELAY_URL. Is it running?');
  process.exitCode = 1;
  ws.terminate();
}, TIMEOUT_MS);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'get_peers' }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'peers') {
    clearTimeout(timer);
    console.log('=== Claude Relay Peers (live) ===');
    console.log('');
    if (!msg.peers.length) {
      console.log('No peers currently connected.');
    } else {
      msg.peers.forEach((id) => console.log('  ' + id));
    }
    console.log('');
    ws.close();
  }
});

ws.on('error', (err) => {
  clearTimeout(timer);
  console.error('Could not reach relay server at $RELAY_URL: ' + err.message);
  process.exitCode = 1;
});
"
