'use strict';

const fs = require('fs');

// EX_CONFIG: recognized preflight failures cannot be cured by immediate retries.
const STARTUP_FAILURE_EXIT = 78;
const REASONS = Object.freeze({
  git_required: 'Codex refused to start outside a Git repository. The relay launcher needs --skip-git-repo-check.',
  workspace_missing: 'The registered working directory is missing or unavailable. Correct the peer working directory before waking it again.',
  executable_missing: 'The Codex executable is missing or cannot be executed by the relay service.',
  session_missing: 'No exact resumable Codex session was found. Open the intended conversation and reconnect its relay bridge.'
});

function classifyStartupFailure(stderr) {
  return /Not inside a trusted directory and --skip-git-repo-check was not specified\./.test(stderr)
    ? 'git_required' : null;
}

function writeStartupFailure(code, file = process.env.RELAY_JOB_FAILURE_FILE) {
  if (!Object.hasOwn(REASONS, code) || !file) return;
  // Only fixed codes leave the runner; provider output never enters this file.
  try { fs.writeFileSync(file, code, { mode: 0o600 }); } catch { /* exit 78 still prevents retries */ }
}

function readStartupFailure(file) {
  try {
    if (fs.statSync(file).size > 100) return null;
    const code = fs.readFileSync(file, 'utf8').trim();
    return Object.hasOwn(REASONS, code) ? REASONS[code] : null;
  } catch { return null; }
}

if (require.main === module) {
  const code = process.argv[2];
  if (!Object.hasOwn(REASONS, code)) process.exit(2);
  writeStartupFailure(code);
  console.error(REASONS[code]);
  process.exit(STARTUP_FAILURE_EXIT);
}

module.exports = { STARTUP_FAILURE_EXIT, classifyStartupFailure, writeStartupFailure, readStartupFailure };
