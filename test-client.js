#!/usr/bin/env node
/**
 * Test client for Claude Relay Server
 *
 * Usage: node test-client.js [clientId] [relayUrl]
 * Example: node test-client.js M2 ws://localhost:9999
 */

const WebSocket = require('ws');
const readline = require('readline');

const CLIENT_ID = process.argv[2] || 'TEST';
const RELAY_URL = process.argv[3] || 'ws://localhost:9999';

console.log(`\nConnecting to ${RELAY_URL} as "${CLIENT_ID}"...`);

const ws = new WebSocket(RELAY_URL);

ws.on('open', () => {
  console.log('Connected! Registering...');
  ws.send(JSON.stringify({
    type: 'register',
    clientId: CLIENT_ID
  }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('\n[RECEIVED]', JSON.stringify(msg, null, 2));
});

ws.on('close', () => {
  console.log('\nDisconnected from relay');
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('Connection error:', err.message);
  process.exit(1);
});

// Interactive CLI
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('\nCommands:');
console.log('  send <message>     - Send message to all peers');
console.log('  send:<id> <msg>    - Send to specific peer');
console.log('  peers              - List connected peers');
console.log('  history [n]        - Get last n messages');
console.log('  clear              - Clear relay message history');
console.log('  quit               - Exit\n');

rl.on('line', (line) => {
  const input = line.trim();

  if (input === 'quit' || input === 'exit') {
    ws.close();
    rl.close();
    return;
  }

  if (input === 'peers') {
    ws.send(JSON.stringify({ type: 'get_peers' }));
    return;
  }

  if (input.startsWith('history')) {
    const count = parseInt(input.split(' ')[1]) || 10;
    ws.send(JSON.stringify({ type: 'get_history', count }));
    return;
  }

  if (input === 'clear') {
    ws.send(JSON.stringify({ type: 'clear_history' }));
    return;
  }

  if (input.startsWith('send:')) {
    const match = input.match(/^send:(\w+)\s+(.+)$/);
    if (match) {
      ws.send(JSON.stringify({
        type: 'message',
        to: match[1],
        content: match[2]
      }));
      console.log(`Sent to ${match[1]}: ${match[2]}`);
    }
    return;
  }

  if (input.startsWith('send ')) {
    const message = input.substring(5);
    ws.send(JSON.stringify({
      type: 'message',
      content: message
    }));
    console.log(`Sent to all: ${message}`);
    return;
  }

  console.log('Unknown command. Type "quit" to exit.');
});
