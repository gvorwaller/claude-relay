const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');

// Strict MCP clients (Antigravity's modelcontextprotocol/go_sdk) abort the
// whole session when a notification gets a reply, and expect ping to be
// answered. These run against the bridge's stdio with no relay behind it.
function startBridge(t) {
  const mcp = spawn(process.execPath, [
    path.join(__dirname, '..', 'mcp-server.js'), '--relay-url=ws://127.0.0.1:1'
  ], {
    env: { ...process.env, RELAY_CLIENT_ID: 'JSONRPC' },
    stdio: ['pipe', 'pipe', 'ignore']
  });
  t.after(() => mcp.kill('SIGTERM'));
  const seen = [];
  const waiting = [];
  let buffer = '';
  mcp.stdout.setEncoding('utf8');
  mcp.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const value = JSON.parse(line);
      seen.push(value);
      const match = waiting.find(entry => entry.predicate(value));
      if (!match) continue;
      waiting.splice(waiting.indexOf(match), 1);
      clearTimeout(match.timer);
      match.resolve(value);
    }
  });
  const next = predicate => new Promise((resolve, reject) => {
    const entry = { predicate, resolve };
    entry.timer = setTimeout(() => reject(new Error('Timed out waiting for MCP response')), 5000);
    waiting.push(entry);
  });
  const send = value => mcp.stdin.write(`${JSON.stringify(value)}\n`);
  return { seen, next, send };
}

// A response is anything the bridge writes that isn't its own request or
// notification (those carry a method).
const responses = seen => seen.filter(message => !('method' in message));

test('ping is answered with an empty result', async t => {
  const { next, send } = startBridge(t);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await next(message => message.id === 1);

  send({ jsonrpc: '2.0', id: 'p-2', method: 'ping' });
  const pong = await next(message => message.id === 'p-2');
  assert.deepEqual(pong, { jsonrpc: '2.0', id: 'p-2', result: {} });
});

test('notifications never get a reply; unknown requests still get method-not-found', async t => {
  const { seen, next, send } = startBridge(t);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await next(message => message.id === 1);

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' });
  send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99, reason: 'test' } });
  send({ jsonrpc: '2.0', method: 'some/unknown/notification', params: {} });

  // stdin is handled in order, so once this answer is out, any reply to the
  // notifications above would already have been written.
  send({ jsonrpc: '2.0', id: 2, method: 'no/such/method' });
  const unknown = await next(message => message.id === 2);
  assert.equal(unknown.error.code, -32601);
  assert.match(unknown.error.message, /Method not found: no\/such\/method/);

  assert.deepEqual(responses(seen).map(message => message.id), [1, 2],
    `only the two requests may be answered; got ${JSON.stringify(responses(seen))}`);
});
