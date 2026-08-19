#!/usr/bin/env node
'use strict';

/**
 * Submit a wake's own account of what it did to the relay's job store.
 *
 * Called by wake-codex.sh after `codex exec` finishes. The text here is the
 * DELEGATE's claim and the server treats it as untrusted narrative: it is
 * clamped, it cannot move the job's state machine, and it can never
 * contradict the server's own record of what was actually sent.
 *
 * Usage: submit-job-result.js --job-id ID --secret-file PATH
 *                             [--last-message FILE] [--exit-code N]
 */
const fs = require('fs');
const WebSocket = require('ws');

const args = process.argv.slice(2);
const value = name => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : null;
};

const jobId = value('--job-id');
const secretFile = value('--secret-file');
const lastMessageFile = value('--last-message');
const exitCode = value('--exit-code');
const relayUrl = value('--relay-url') || process.env.RELAY_URL || 'ws://localhost:9999';

if (!jobId || !secretFile) {
  console.error('Usage: submit-job-result.js --job-id ID --secret-file PATH [--last-message FILE] [--exit-code N]');
  process.exit(2);
}

let secret = null;
try {
  secret = fs.readFileSync(secretFile, 'utf8').trim();
} catch {
  console.error('no result credential available');
  process.exit(2);
}

// Codex's final assistant message. If an --output-schema was used it is JSON
// with the agreed fields; otherwise it is prose we summarize positionally.
let summary = null;
let changes = null;
let verification = [];
let replyAttempted = null;
if (lastMessageFile) {
  try {
    const raw = fs.readFileSync(lastMessageFile, 'utf8').trim();
    try {
      const parsed = JSON.parse(raw);
      summary = typeof parsed.summary === 'string' ? parsed.summary : null;
      changes = typeof parsed.changes === 'string' ? parsed.changes : null;
      verification = Array.isArray(parsed.verification) ? parsed.verification : [];
      replyAttempted = typeof parsed.replyAttempted === 'boolean' ? parsed.replyAttempted : null;
    } catch {
      // Not structured: keep the opening of the final message as the summary
      // rather than inventing fields.
      summary = raw.split('\n').filter(Boolean).slice(0, 4).join(' ').slice(0, 2000) || null;
    }
  } catch { /* no final message captured */ }
}
if (!summary && exitCode !== null) {
  summary = `The wake process exited with code ${exitCode} without producing a final message.`;
}

const ws = new WebSocket(relayUrl);
const done = code => {
  try { ws.close(); } catch {}
  process.exit(code);
};
setTimeout(() => done(1), 10000).unref();

ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'submit_job_result',
    jobId,
    resultSecret: secret,
    summary,
    changes,
    verification,
    replyAttempted
  }));
});
ws.on('message', data => {
  try {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'job_result_recorded') {
      try { fs.unlinkSync(secretFile); } catch {}
      return done(0);
    }
    if (msg.type === 'error') {
      console.error(`result rejected: ${msg.message}`);
      return done(1);
    }
  } catch { /* ignore */ }
});
ws.on('error', err => {
  console.error(`relay unreachable: ${err.message}`);
  done(1);
});
