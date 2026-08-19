'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

function jsonLineHarness(stream) {
  let buffer = '';
  const waiters = [];
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const value = JSON.parse(line);
      const waiter = waiters.find(entry => entry.predicate(value));
      if (!waiter) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(value);
    }
  });
  return predicate => new Promise(resolve => waiters.push({ predicate, resolve }));
}

test('relay_send never reports success without the relay server sent ack', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-send-ack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const server = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const port = server.address().port;

  let registrationResolve;
  const registration = new Promise(resolve => { registrationResolve = resolve; });
  server.on('connection', socket => {
    socket.on('message', data => {
      const message = JSON.parse(data);
      if (message.type === 'register') {
        socket.send(JSON.stringify({
          type: 'registered',
          clientId: message.clientId,
          peers: []
        }));
        registrationResolve();
      }
      // Deliberately ignore `message`: this simulates the exact failure mode
      // where transport is open but no authoritative `sent` ack arrives.
    });
  });

  const mcp = spawn(process.execPath, [path.join(__dirname, '..', 'mcp-server.js'),
    `--relay-url=ws://127.0.0.1:${port}`, '--client-id=ACK-TEST'], {
    env: { ...process.env, HOME: root },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => mcp.kill('SIGTERM'));
  const next = jsonLineHarness(mcp.stdout);
  const send = value => mcp.stdin.write(`${JSON.stringify(value)}\n`);

  const initialized = next(value => value.id === 1);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await initialized;
  await registration;

  const response = next(value => value.id === 2);
  send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'relay_send',
      arguments: { to: 'CC1', message: 'must be acknowledged' }
    }
  });
  const text = (await response).result.content[0].text;
  assert.match(text, /did not acknowledge/);
  assert.match(text, /Delivery is unconfirmed/);
  assert.doesNotMatch(text, /^Message sent/);
});
