#!/usr/bin/env node
'use strict';

// Consume Grok's streaming-messages-json without persisting prompts, reasoning,
// commands, tool arguments, or tool output. Only fixed activity categories and
// the final operator-facing result are retained.
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { projectGrokEvent } = require('../delegate-activity');

const args = process.argv.slice(2);
const separator = args.indexOf('--');
if (separator < 0 || !args[separator + 1]) process.exit(2);
const lastMessageIndex = args.indexOf('--last-message');
const lastMessageFile = lastMessageIndex >= 0 ? args[lastMessageIndex + 1] : null;
const command = args[separator + 1];
const commandArgs = args.slice(separator + 2);
const relayUrl = process.env.RELAY_URL || 'ws://localhost:9999';
const jobId = process.env.RELAY_JOB_ID || null;
let resultSecret = null;
try {
  resultSecret = fs.readFileSync(process.env.RELAY_JOB_RESULT_SECRET_FILE, 'utf8').trim();
} catch { /* activity is optional; the delegate can still run */ }

function submitActivity(activityType) {
  if (!jobId || !resultSecret || !activityType) return Promise.resolve();
  return new Promise(resolve => {
    const ws = new WebSocket(relayUrl);
    const finish = () => { try { ws.close(); } catch {} resolve(); };
    const timer = setTimeout(finish, 2500);
    timer.unref();
    ws.on('error', finish);
    ws.on('open', () => ws.send(JSON.stringify({
      type: 'submit_job_activity', jobId, resultSecret, activityType
    })));
    ws.on('message', () => { clearTimeout(timer); finish(); });
  });
}

const child = spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
let buffer = '';
let stderrBytes = 0;
let finalResult = '';
let submitted = 0;
const pending = new Set();
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'result' && typeof event.result === 'string') finalResult = event.result;
    const projected = projectGrokEvent(event);
    if (projected && submitted < 100) {
      submitted += 1;
      const request = submitActivity(projected);
      pending.add(request);
      request.finally(() => pending.delete(request));
    }
  }
});
child.stderr.on('data', chunk => {
  if (stderrBytes >= 65536) return;
  const slice = chunk.subarray(0, 65536 - stderrBytes);
  stderrBytes += slice.length;
  process.stderr.write(slice);
});
child.on('error', () => process.exit(1));
child.on('exit', code => {
  if (lastMessageFile && finalResult) {
    try { fs.writeFileSync(lastMessageFile, finalResult, { mode: 0o600 }); } catch {}
  }
  const settle = Promise.allSettled(Array.from(pending));
  const deadline = new Promise(resolve => setTimeout(resolve, 3000));
  Promise.race([settle, deadline]).finally(() => process.exit(code === null ? 1 : code));
});
