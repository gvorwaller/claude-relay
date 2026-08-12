const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { notifyDelegate } = require('../delegate-notifier');

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
