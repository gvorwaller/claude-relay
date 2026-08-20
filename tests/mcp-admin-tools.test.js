const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');

function mcpLines(stream) {
  let buffer = '';
  const waiting = [];
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const value = JSON.parse(line);
      const match = waiting.find(entry => entry.predicate(value));
      if (!match) continue;
      waiting.splice(waiting.indexOf(match), 1);
      clearTimeout(match.timer);
      match.resolve(value);
    }
  });
  return predicate => new Promise((resolve, reject) => {
    const entry = { predicate, resolve };
    entry.timer = setTimeout(() => reject(new Error('Timed out waiting for MCP response')), 5000);
    waiting.push(entry);
  });
}

test('MCP advertises and dispatches delegate-job admin tools', async t => {
  const mcp = spawn(process.execPath, [
    path.join(__dirname, '..', 'mcp-server.js'), '--relay-url=ws://127.0.0.1:1'
  ], {
    env: { ...process.env, RELAY_CLIENT_ID: 'ADMINTOOLS' },
    stdio: ['pipe', 'pipe', 'ignore']
  });
  t.after(() => mcp.kill('SIGTERM'));
  const next = mcpLines(mcp.stdout);
  const send = value => mcp.stdin.write(`${JSON.stringify(value)}\n`);

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await next(message => message.id === 1);
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listed = await next(message => message.id === 2);
  const names = listed.result.tools.map(tool => tool.name);
  assert.ok(names.includes('relay_delegate_jobs'));
  assert.ok(names.includes('relay_purge_delegate_jobs'));

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
    name: 'relay_delegate_jobs', arguments: { owner: 'CODEX1' }
  }});
  const dispatched = await next(message => message.id === 3);
  assert.match(dispatched.result.content[0].text, /Not connected.*delegate jobs/);
});

test('Claude Code automatically receives the lean relay profile', async t => {
  const mcp = spawn(process.execPath, [
    path.join(__dirname, '..', 'mcp-server.js'), '--relay-url=ws://127.0.0.1:1'
  ], {
    env: {
      ...process.env,
      RELAY_CLIENT_ID: 'CC1',
      RELAY_TOOL_PROFILE: '',
      CLAUDE_CODE_SESSION_ID: '11111111-1111-4111-8111-111111111111'
    },
    stdio: ['pipe', 'pipe', 'ignore']
  });
  t.after(() => mcp.kill('SIGTERM'));
  const next = mcpLines(mcp.stdout);
  const send = value => mcp.stdin.write(`${JSON.stringify(value)}\n`);

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await next(message => message.id === 1);
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listed = await next(message => message.id === 2);
  assert.deepEqual(listed.result.tools.map(tool => tool.name), [
    'relay_send', 'relay_receive', 'relay_peers', 'relay_status', 'relay_rename'
  ]);

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
    name: 'relay_wait', arguments: { timeoutSeconds: 1 }
  }});
  assert.match((await next(message => message.id === 3)).error.message,
    /disabled for Claude Code.*Stop hook/);
});

test('explicit full profile overrides Claude Code auto-detection without changing identity', async t => {
  const mcp = spawn(process.execPath, [
    path.join(__dirname, '..', 'mcp-server.js'), '--relay-url=ws://127.0.0.1:1'
  ], {
    env: {
      ...process.env,
      RELAY_CLIENT_ID: 'CC1',
      RELAY_TOOL_PROFILE: 'full',
      CLAUDE_CODE_SESSION_ID: '22222222-2222-4222-8222-222222222222'
    },
    stdio: ['pipe', 'pipe', 'ignore']
  });
  t.after(() => mcp.kill('SIGTERM'));
  const next = mcpLines(mcp.stdout);
  const send = value => mcp.stdin.write(`${JSON.stringify(value)}\n`);

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await next(message => message.id === 1);
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const names = (await next(message => message.id === 2)).result.tools.map(tool => tool.name);
  assert.ok(names.includes('relay_wait'));
  assert.ok(names.includes('relay_delegate_jobs'));
});
