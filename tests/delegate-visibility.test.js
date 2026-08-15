const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { notifyDelegate } = require('../delegate-notifier');
const { projectGrokEvent } = require('../delegate-activity');

test('relay-monitor renders sanitized activity and never arbitrary job fields', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-monitor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'jobs'));
  fs.writeFileSync(path.join(root, 'jobs', 'wake_test.json'), JSON.stringify({
    owner: 'CODEX3', from: 'CC5', status: 'running', requestedAt: new Date().toISOString(),
    activity: [{ type: 'running_command', at: new Date().toISOString(), command: 'cat /secret' }],
    outbound: [], secret: 'TOP_SECRET', summary: 'private prose'
  }));
  const output = execFileSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'relay-monitor.js'), '--data-dir', root, '--once'
  ], { encoding: 'utf8' });
  assert.match(output, /CODEX3  running/);
  assert.match(output, /Running a command/);
  assert.doesNotMatch(output, /cat \/secret|TOP_SECRET|private prose/);
});

test('delegate notifications use fixed AppleScript and content-minimized argv', () => {
  let call;
  notifyDelegate({ owner: 'CODEX3', state: 'completed', message: 'secret body' }, (...args) => {
    call = args;
    return { unref() {} };
  });
  assert.equal(call[0], '/usr/bin/osascript');
  assert.match(call[1].join(' '), /CODEX3: completed/);
  assert.doesNotMatch(call[1].join(' '), /secret body/);
});

test('delegate runner forwards bounded child stderr for operator diagnosis', () => {
  const runner = path.join(__dirname, '..', 'scripts', 'run-codex-delegate.js');
  const result = spawnSync(process.execPath, [runner, '--', process.execPath, '-e',
    'process.stderr.write("resume refused\\n"); process.exit(7)'], {
    encoding: 'utf8',
    env: { ...process.env, RELAY_JOB_RESULT_SECRET_FILE: '' }
  });
  assert.equal(result.status, 7);
  assert.match(result.stderr, /resume refused/);
});

test('every live Codex wake uses a fresh same-cwd delegate', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'wake-codex.sh'), 'utf8'
  );
  assert.match(source, /PEER_LIVE=1/);
  assert.match(source, /IS_CODEX.*PEER_LIVE.*FRESH_DELEGATE=1/s);
  assert.doesNotMatch(source, /if \[\[ "\$PARENT_ARGS" == \*" app-server"/);
  assert.match(source, /codex exec --json.*-C "\$PEER_CWD"/s);
  assert.match(source, /live foreground session stays attached/);
  assert.match(source, /--output-schema "\$RESULT_SCHEMA"/);
  const schema = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'delegate-result-schema.json'), 'utf8'
  ));
  assert.deepEqual(schema.required, ['summary', 'changes', 'verification']);
});

test('Grok activity projection is sanitized and classifies relay tools', () => {
  const event = name => ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, input: { secret: 'do not retain' } }] }
  });
  assert.equal(projectGrokEvent(event('claude-relay__relay_receive')), 'reading_message');
  assert.equal(projectGrokEvent(event('claude-relay__relay_send')), 'sending_reply');
  assert.equal(projectGrokEvent(event('run_terminal_command')), 'running_command');
  assert.equal(projectGrokEvent({ type: 'result', is_error: false, result: 'private' }), 'finishing');
});

test('Grok wake is a fresh same-cwd delegate and never resumes foreground session', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'wake-grok.sh'), 'utf8'
  );
  assert.match(source, /RELAY_DELEGATE_FOR="\$FOR"/);
  assert.match(source, /grok --no-leader --cwd "\$PEER_CWD" --always-approve/);
  assert.match(source, /streaming-messages-json/);
  assert.doesNotMatch(source, /--resume|-r "\$PEER/);
});

test('wildcard wake dispatcher routes both Codex and Grok before delegate launch', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'wake-peer.sh'), 'utf8'
  );
  assert.match(source, /exec .*wake-codex\.sh/);
  assert.match(source, /exec .*wake-grok\.sh/);
});

test('wildcard wake dispatcher tolerates the notify hook passing no argv', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wake-peer-'));
  try {
    const registry = path.join(root, 'registry.json');
    fs.writeFileSync(registry, JSON.stringify({
      OTHER: { pid: 0, cwd: root }
    }));
    const result = spawnSync(path.join(__dirname, '..', 'scripts', 'wake-peer.sh'), [], {
      encoding: 'utf8',
      env: { ...process.env, RELAY_FOR: 'OTHER', RELAY_REGISTRY: registry }
    });
    assert.equal(result.status, 64);
    assert.doesNotMatch(result.stderr, /unbound variable/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Grok runner captures only the terminal result for the operator report', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-grok-runner-'));
  try {
    const output = path.join(root, 'last-message.json');
    const fixture = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'thinking', thinking: 'private reasoning' },
        { type: 'tool_use', name: 'claude-relay__relay_receive', input: { secret: 'private' } }
      ] } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
        result: '{"summary":"done","changes":"None","verification":[]}' })
    ].join('\n') + '\n';
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'scripts', 'run-grok-delegate.js'),
      '--last-message', output, '--', process.execPath, '-e',
      `process.stdout.write(${JSON.stringify(fixture)})`
    ], { encoding: 'utf8', env: { ...process.env, RELAY_JOB_RESULT_SECRET_FILE: '' } });
    assert.equal(result.status, 0);
    assert.equal(fs.readFileSync(output, 'utf8'),
      '{"summary":"done","changes":"None","verification":[]}');
    assert.doesNotMatch(fs.readFileSync(output, 'utf8'), /private reasoning|private/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
