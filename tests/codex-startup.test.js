'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { NotifyHooks } = require('../notify-hooks');
const { CapabilityStore } = require('../capabilities');
const { DelegateJobStore } = require('../delegate-job-store');
const { readStartupFailure } = require('../delegate-startup-failure');
const repo = path.resolve(__dirname, '..');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-startup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('Codex wake launches in the exact registered directory, with a Git override only outside Git', t => {
  const root = temporary(t);
  const scripts = path.join(root, 'scripts');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(scripts); fs.mkdirSync(bin);
  // Replace only the installation-specific PATH; execute the actual shell
  // launcher and real event runner against a harmless fake Codex executable.
  const source = fs.readFileSync(path.join(repo, 'scripts/wake-codex.sh'), 'utf8')
    .replace(/^export PATH=.*$/m, 'export PATH="$TEST_BIN:$PATH"');
  fs.writeFileSync(path.join(scripts, 'wake-codex.sh'), source);
  for (const name of ['run-codex-delegate.js', 'delegate-result-schema.json']) {
    fs.symlinkSync(path.join(repo, 'scripts', name), path.join(scripts, name));
  }
  fs.symlinkSync(path.join(repo, 'delegate-startup-failure.js'), path.join(root, 'delegate-startup-failure.js'));
  fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}\nrequire('fs').writeFileSync(process.env.CAPTURE, JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));\n`, { mode: 0o700 });
  const workspace = path.join(root, 'desktop chat with spaces');
  fs.mkdirSync(workspace);
  const registry = path.join(root, 'registry.json');
  const capture = path.join(root, 'capture.json');
  const failure = path.join(root, 'failure');
  const env = { ...process.env, TEST_BIN: bin, CAPTURE: capture, RELAY_REGISTRY: registry,
    RELAY_FOR: '', RELAY_JOB_ID: '', RELAY_JOB_RESULT_SECRET_FILE: '', RELAY_JOB_FAILURE_FILE: failure };
  fs.writeFileSync(registry, JSON.stringify({ CODEXTEST: { pid: process.pid, cwd: workspace } }));
  for (const isGit of [false, true]) {
    if (isGit) assert.equal(spawnSync('git', ['init', workspace]).status, 0);
    const result = spawnSync('/bin/bash', [path.join(scripts, 'wake-codex.sh'), 'CODEXTEST', 'No relay work'], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const launched = JSON.parse(fs.readFileSync(capture));
    assert.equal(fs.realpathSync(launched.cwd), fs.realpathSync(workspace));
    assert.equal(launched.args[launched.args.indexOf('-C') + 1], workspace);
    assert.equal(launched.args.includes('--skip-git-repo-check'), !isGit);
    assert.equal(launched.args.includes('resume'), false);
  }
  fs.rmSync(capture);
  fs.writeFileSync(registry, JSON.stringify({ CODEXTEST: { pid: process.pid, cwd: path.join(root, 'missing') } }));
  const bad = spawnSync('/bin/bash', [path.join(scripts, 'wake-codex.sh'), 'CODEXTEST'], { env, encoding: 'utf8' });
  assert.equal(bad.status, 78);
  assert.match(readStartupFailure(failure), /registered working directory is missing/);
  assert.equal(fs.existsSync(capture), false, 'must not fall back to daemon cwd');
});

test('runner classifies only recognized startup errors and never copies stderr into the failure record', t => {
  const root = temporary(t);
  const file = path.join(root, 'failure');
  const error = 'Not inside a trusted directory and --skip-git-repo-check was not specified.';
  for (const [started, expected] of [[false, 78], [true, 1]]) {
    fs.writeFileSync(file, '');
    const result = spawnSync(process.execPath, [path.join(repo, 'scripts/run-codex-delegate.js'), '--', process.execPath, '-e',
      `${started ? 'console.log(JSON.stringify({type:"turn.started"}));' : ''} setTimeout(()=>{console.error(${JSON.stringify(error + ' token=DO_NOT_PUBLISH')});process.exit(1)},50);`],
    { encoding: 'utf8', env: { ...process.env, RELAY_JOB_RESULT_SECRET_FILE: '', RELAY_JOB_FAILURE_FILE: file } });
    assert.equal(result.status, expected);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /DO_NOT_PUBLISH/);
    assert.equal(Boolean(readStartupFailure(file)), !started);
  }
  const missing = spawnSync(process.execPath, [path.join(repo, 'scripts/run-codex-delegate.js'), '--', path.join(root, 'no-codex')],
    { env: { ...process.env, RELAY_JOB_FAILURE_FILE: file } });
  assert.equal(missing.status, 78);
  assert.match(readStartupFailure(file), /executable is missing/);
});

test('real notify runner records permanent failure once, cleans credentials, and allows later mail', async t => {
  const root = temporary(t);
  const capabilities = new CapabilityStore({ dataDir: root });
  const store = new DelegateJobStore({ dataDir: path.join(root, 'jobs') }).initialize();
  const configPath = path.join(root, 'notify.json');
  const shellQuote = text => `'${text.replace(/'/g, `'"'"'`)}'`;
  fs.writeFileSync(configPath, JSON.stringify({ CODEXTEST: [{ type: 'exec', debounceSeconds: 0,
    command: `${shellQuote(process.execPath)} ${shellQuote(path.join(repo, 'delegate-startup-failure.js'))} git_required` }] }));
  const outcomes = [];
  const hooks = new NotifyHooks({ configPath, capabilities, jobStore: store, retryDelayMs: 20,
    notifier() {}, logger: { info() {}, warn() {}, error: (event, data) => outcomes.push({ event, data }) } });
  for (const messageId of ['one', 'two']) {
    hooks.fire({ to: 'CODEXTEST', from: 'CC1', messageId, delivered: true });
    for (let count = 0; count < 100 && outcomes.length < (messageId === 'one' ? 1 : 2); count++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(store.jobs.size, messageId === 'one' ? 1 : 2, 'no automatic retries');
  }
  for (const job of store.jobs.values()) {
    assert.equal(job.status, 'failed');
    assert.equal(job.exitCode, 78);
    assert.match(job.reason, /outside a Git repository/);
  }
  assert.equal(hooks.pendingTrailing.size, 0);
  assert.equal(capabilities.jobs.size, 0);
  assert.equal(capabilities.resultSecrets.size, 0);
  assert.ok(outcomes.every(item => item.event === 'notify_hook_permanent_failure'));
});
