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

test('wildcard debounce is per target, not per entry', t => {
  let clock = 5000000;
  const { hooks, fired } = makeHooks(t, {
    '*': [{ type: 'exec', command: 'poke', debounceSeconds: 60 }]
  }, { now: () => clock });
  hooks.fire({ to: 'CODEX3', from: 'CC5', messageId: 'w1', delivered: false });
  clock += 1000;
  hooks.fire({ to: 'CODEX', from: 'CC5', messageId: 'w2', delivered: false });
  assert.equal(fired.length, 2, 'different targets each fire despite one shared entry');
  clock += 1000;
  hooks.fire({ to: 'CODEX', from: 'CC5', messageId: 'w3', delivered: false });
  assert.equal(fired.length, 2, 'same target within the window is debounced');
});

test('a live delegate suppresses exec wakes but not banners', t => {
  const { hooks, fired } = makeHooks(t, {
    CODEX3: [
      { type: 'exec', command: 'poke' },
      { type: 'banner' }
    ]
  });
  hooks.fire({ to: 'CODEX3', from: 'CC5', messageId: 'd1', delivered: true, deliveredToDelegate: true });
  assert.deepEqual(fired.map(f => f.entry.type), ['banner']);
  hooks.fire({ to: 'CODEX3', from: 'CC5', messageId: 'd2', delivered: false, deliveredToDelegate: false });
  assert.deepEqual(fired.map(f => f.entry.type), ['banner', 'exec', 'banner']);
});

test('a debounced message still gets a trailing-edge wake', async t => {
  const { hooks, fired } = makeHooks(t, {
    CODEX3: [{ type: 'exec', command: 'poke', debounceSeconds: 0.15 }]
  });
  hooks.fire({ to: 'CODEX3', from: 'CC5', messageId: 't1', delivered: false });
  hooks.fire({ to: 'CODEX3', from: 'CC5', messageId: 't2', delivered: false });
  assert.equal(fired.length, 1, 'second fire suppressed inside the window');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(fired.length, 2, 'suppressed message wakes once the window closes');
});

test('delegate-suppressed exec gets a trailing-edge wake too', async t => {
  const { hooks, fired } = makeHooks(t, {
    CODEX3: [{ type: 'exec', command: 'poke', debounceSeconds: 0.1 }]
  });
  hooks.fire({ to: 'CODEX3', from: 'CC5', messageId: 'd1', delivered: true, deliveredToDelegate: true });
  assert.equal(fired.length, 0, 'no immediate wake while a delegate is live');
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(fired.length, 1, 'wake fires after the delegate window in case it exited unread');
});

test('a failed runner does not start a debounce window that eats the retry', t => {
  let shouldThrow = true;
  const fired = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-notify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'notify.json');
  fs.writeFileSync(configPath, JSON.stringify({
    CODEX3: [{ type: 'exec', command: 'poke', debounceSeconds: 300 }]
  }));
  const hooks = new NotifyHooks({
    configPath,
    runner: entry => {
      if (shouldThrow) throw new Error('spawn failed');
      fired.push(entry);
    }
  });
  hooks.fire({ to: 'CODEX3', from: 'CC5', messageId: 'f1', delivered: false });
  assert.equal(fired.length, 0);
  shouldThrow = false;
  hooks.fire({ to: 'CODEX3', from: 'CC5', messageId: 'f2', delivered: false });
  assert.equal(fired.length, 1, 'retry fires immediately because the failure committed no window');
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

test('a command that spawns but exits nonzero early is retried (shell-127 case)', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-notify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'notify.json');
  fs.writeFileSync(configPath, JSON.stringify({
    CODEX3: [{ type: 'exec', command: 'poke', debounceSeconds: 300 }]
  }));
  const attempts = [];
  const hooks = new NotifyHooks({
    configPath,
    retryDelayMs: 60,
    maxRetries: 2,
    // Emulate production: the spawn "succeeds" synchronously, the failure
    // arrives later as a nonzero exit.
    runner: (entry, context, onOutcome) => {
      attempts.push(context.messageId);
      setTimeout(() => onOutcome({ ok: false, code: 127 }), 10);
    }
  });
  hooks.fire({ to: 'CODEX3', from: 'CC5', messageId: 'e1', delivered: false });
  assert.equal(attempts.length, 1);
  // Debounce must NOT block the retry, and retries are bounded.
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.ok(attempts.length >= 2, `expected a retry after early nonzero exit, got ${attempts.length}`);
  assert.ok(attempts.length <= 3, `retries must be bounded, got ${attempts.length}`);
});

test('a long-running command exiting nonzero later is not treated as a failed spawn', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-notify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'notify.json');
  fs.writeFileSync(configPath, JSON.stringify({
    CODEX3: [{ type: 'exec', command: 'poke', debounceSeconds: 300 }]
  }));
  const attempts = [];
  const hooks = new NotifyHooks({
    configPath,
    retryDelayMs: 50,
    runner: (entry, context, onOutcome) => {
      attempts.push(context.messageId);
      setTimeout(() => onOutcome({ ok: true, code: 1 }), 10);
    }
  });
  hooks.fire({ to: 'CODEX3', from: 'CC5', messageId: 'l1', delivered: false });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(attempts.length, 1, 'a real run that later failed must not be retried as a bad spawn');
});
