const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const [mcpServer, root, project, port, oldRollout, currentRollout, oldSession] = process.argv.slice(2);
const heldFiles = [fs.openSync(oldRollout, 'r'), fs.openSync(currentRollout, 'r')];
const common = {
  ...process.env,
  HOME: root,
  RELAY_CLIENT_ID: 'CODEX'
};

const predecessor = spawn(process.execPath, [mcpServer], {
  cwd: project,
  env: common,
  stdio: ['pipe', 'ignore', 'pipe']
});
predecessor.stderr.pipe(process.stderr);

const sessions = path.join(root, 'claude-relay', 'sessions');
fs.mkdirSync(sessions, { recursive: true });
fs.writeFileSync(path.join(sessions, 'registry.json'), JSON.stringify({
  CODEX1: {
    pid: predecessor.pid,
    cwd: project,
    source: 'registry-cwd',
    codexSessionId: oldSession
  }
}));

const replacement = spawn(process.execPath, [
  mcpServer,
  `--relay-url=ws://127.0.0.1:${port}`
], {
  cwd: project,
  env: common,
  stdio: ['pipe', 'pipe', 'pipe']
});
process.stdin.pipe(replacement.stdin);
replacement.stdout.pipe(process.stdout);
replacement.stderr.pipe(process.stderr);

function stop(signal = 'SIGTERM') {
  if (predecessor.exitCode === null) predecessor.kill(signal);
  if (replacement.exitCode === null) replacement.kill(signal);
  for (const fd of heldFiles) {
    try { fs.closeSync(fd); } catch {}
  }
}

process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
replacement.on('exit', code => {
  stop('SIGTERM');
  process.exit(code || 0);
});
