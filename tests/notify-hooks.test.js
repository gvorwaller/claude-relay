const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { NotifyHooks } = require('/Users/gaylonvorwaller/claude-relay/notify-hooks');

function makeHooks(t, config, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-notify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'notify.json');
  if (config !== undefined) fs.writeFileSync(configPath, JSON.stringify(config));
  const fired = [];
  const hooks = new NotifyHooks({
    configPath,
    runner: (entry, context) => {
      if (options.runnerThrows) throw new Error('runner exploded');
      fired.push({ entry, context });
    },
    now: options.now,
    logger: options.logger
  });
  return { hooks, fired, configPath };
}

test('direct message fires target and wildcard entries with context', t => {
  const { hooks, fired } = makeHooks(t, {
    CODEX3: [{ type: 'exec', command: 'poke' }],
    '*': [{ type: 'banner' }]
  });
  hooks.fire({ to: 'CODEX3', from: 'CC5', messageId: 'm1', delivered: false });
  assert.equal(fired.length, 2);
  assert.deepEqual(fired.map(f => f.entry.type).sort(), ['banner', 'exec']);
  assert.deepEqual(fired[0].context, { target: 'CODEX3', from: 'CC5', messageId: 'm1', delivered: false });
});

test('broadcast fires every named key except the sender, wildcard once', t => {
  const { hooks, fired } = makeHooks(t, {
    CC5: [{ type: 'exec', command: 'a' }],
    CODEX3: [{ type: 'exec', command: 'b' }],
    '*': [{ type: 'banner' }]
  });
  hooks.fire({ to: 'all', from: 'CC5', messageId: 'm2', delivered: true });
  assert.deepEqual(
    fired.map(f => f.context.target).sort(),
    ['CODEX3', 'all']
  );
});

test('onlyIfUndelivered skips live deliveries and fires for queued mail', t => {
  const { hooks, fired } = makeHooks(t, {
    CODEX3: [{ type: 'banner', onlyIfUndelivered: true }]
  });
  hooks.fire({ to: 'CODEX3', from: 'CC5', messageId: 'm3', delivered: true });
  assert.equal(fired.length, 0);
  hooks.fire({ to: 'CODEX3', from: 'CC5', messageId: 'm4', delivered: false });
  assert.equal(fired.length, 1);
});

test('debounceSeconds collapses a burst into one firing', t => {
  let clock = 1000000;
  const { hooks, fired } = makeHooks(t, {
    CODEX3: [{ type: 'exec', command: 'poke', debounceSeconds: 300 }]
  }, { now: () => clock });
  hooks.fire({ to: 'CODEX3', from: 'CC5', messageId: 'm5', delivered: false });
  clock += 60 * 1000;
  hooks.fire({ to: 'CODEX3', from: 'CC5', messageId: 'm6', delivered: false });
  assert.equal(fired.length, 1);
  clock += 300 * 1000;
  hooks.fire({ to: 'CODEX3', from: 'CC5', messageId: 'm7', delivered: false });
  assert.equal(fired.length, 2);
});

test('missing or invalid config disables hooks without throwing', t => {
  const { hooks, fired, configPath } = makeHooks(t, undefined);
  hooks.fire({ to: 'CODEX3', from: 'CC5', messageId: 'm8', delivered: false });
  assert.equal(fired.length, 0);

  fs.writeFileSync(configPath, 'not json at all');
  hooks.fire({ to: 'CODEX3', from: 'CC5', messageId: 'm9', delivered: false });
  assert.equal(fired.length, 0);
});

test('config edits are picked up without restart via mtime reload', async t => {
  const { hooks, fired, configPath } = makeHooks(t, {});
  hooks.fire({ to: 'CODEX3', from: 'CC5', messageId: 'm10', delivered: false });
  assert.equal(fired.length, 0);

  // Ensure a distinct mtime, then add a hook for the target.
  await new Promise(resolve => setTimeout(resolve, 20));
  fs.writeFileSync(configPath, JSON.stringify({ CODEX3: [{ type: 'exec', command: 'poke' }] }));
  const stat = fs.statSync(configPath);
  fs.utimesSync(configPath, stat.atime, new Date(stat.mtimeMs + 1000));
  hooks.fire({ to: 'CODEX3', from: 'CC5', messageId: 'm11', delivered: false });
  assert.equal(fired.length, 1);
});

test('a throwing runner is contained and logged, never propagated', t => {
  const warnings = [];
  const { hooks, fired } = makeHooks(t, {
    CODEX3: [{ type: 'exec', command: 'poke' }]
  }, {
    runnerThrows: true,
    logger: { info() {}, warn: (event, data) => warnings.push({ event, data }), error() {} }
  });
  assert.doesNotThrow(() =>
    hooks.fire({ to: 'CODEX3', from: 'CC5', messageId: 'm12', delivered: false }));
  assert.equal(fired.length, 0);
  assert.equal(warnings[0].event, 'notify_hook_failed');
});
