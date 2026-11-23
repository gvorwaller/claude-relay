#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { projectCodexEvent } = require('../delegate-activity');
const {
  STARTUP_FAILURE_EXIT, classifyStartupFailure, classifyProviderFailure, writeStartupFailure
} = require('../delegate-startup-failure');

const args = process.argv.slice(2);
const separator = args.indexOf('--');
if (separator < 0 || !args[separator + 1]) process.exit(2);
const command = args[separator + 1];
const commandArgs = args.slice(separator + 2);
const relayUrl = process.env.RELAY_URL || 'ws://localhost:9999';
const jobId = process.env.RELAY_JOB_ID || null;
let resultSecret = null;
try {
  resultSecret = fs.readFileSync(process.env.RELAY_JOB_RESULT_SECRET_FILE, 'utf8').trim();
} catch { /* activity is optional; the delegate itself can still run */ }

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

// The wake log is shared by every peer and every wake, so each line the
// runner writes says when and for whom. Codex's raw stderr and these lines
// share one bounded budget per wake.
const STDERR_BUDGET = 65536;
let stderrBytes = 0;
const logLabel = `[${process.env.RELAY_DELEGATE_FOR || 'delegate'}${jobId ? ` ${jobId}` : ''}]`;
function logLine(text) {
  if (stderrBytes >= STDERR_BUDGET) return;
  const line = Buffer.from(`${new Date().toISOString()} ${logLabel} ${text}\n`, 'utf8')
    .subarray(0, STDERR_BUDGET - stderrBytes);
  stderrBytes += line.length;
  process.stderr.write(line);
}
// Codex reports its own failures (usage limit, sign-in, API errors) as JSON
// events on stdout, not on stderr, so they used to vanish: the job said only
// "exited with code 1" and the wake log was empty. Forward just those
// messages, one line each and length-capped, to the local wake log. They
// never enter the monitor record; a recognised failure reaches the monitor
// only as a fixed reason code (classifyProviderFailure).
function providerMessage(event) {
  if (event.type === 'error') return { kind: 'error', text: event.message };
  if (event.type === 'turn.failed') return { kind: 'turn failed', text: event.error && event.error.message };
  // Error *items* are non-fatal notices (deprecated config keys and the like).
  if (event.type === 'item.completed' && event.item && event.item.type === 'error') {
    return { kind: 'notice', text: event.item.message };
  }
  return null;
}
// One display line per event: C0/C1 controls and Unicode line separators too.
const oneLine = text => String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim().slice(0, 2000);
// The retry decision is made from each event's full text as it arrives;
// only the fixed code is kept. It uses the run's final failure (turn.failed,
// else the latest error event), never the display copy, and never an earlier
// error the run went on past.
let turnFailedCode;
let errorCode;
let lastProviderText = null;

const child = spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
logLine(`started ${command.split('/').pop()}`);
let buffer = '';
let startupStderr = '';
let workStarted = false;
let spawnFailure = null;
const pending = new Set();
let submitted = 0;
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const provider = event && typeof event === 'object' ? providerMessage(event) : null;
    // Every failure event is classified, an empty one included (as no code),
    // so an earlier quota error can't decide a run that failed differently.
    if (provider && provider.kind === 'turn failed') turnFailedCode = classifyProviderFailure(provider.text || '');
    else if (provider && provider.kind === 'error') errorCode = classifyProviderFailure(provider.text || '');
    if (provider && provider.text) {
      const text = oneLine(provider.text);
      // turn.failed repeats the error event's message; log it once.
      if (text !== lastProviderText) logLine(`codex ${provider.kind}: ${text}`);
      lastProviderText = text;
    }
    const projected = projectCodexEvent(event);
    if (projected && projected !== 'error') workStarted = true;
    if (projected && submitted < 100) {
      submitted += 1;
      const request = submitActivity(projected);
      pending.add(request);
      request.finally(() => pending.delete(request));
    }
  }
});
// The runner used to discard stderr, turning configuration and resume errors
// into opaque exit-code-only jobs. Keep it out of the durable monitor record,
// but forward a bounded amount to the local wake log for operator diagnosis.
child.stderr.on('data', chunk => {
  if (stderrBytes >= STDERR_BUDGET) return;
  const slice = chunk.subarray(0, STDERR_BUDGET - stderrBytes);
  stderrBytes += slice.length;
  if (!workStarted) startupStderr += slice.toString('utf8');
  process.stderr.write(slice);
});
child.on('error', error => {
  if (['ENOENT', 'EACCES'].includes(error.code)) spawnFailure = 'executable_missing';
});
// close, unlike exit, guarantees that the stderr pipe has drained.
child.on('close', code => {
  const failure = spawnFailure
    || (!workStarted && code !== 0 && classifyStartupFailure(startupStderr))
    || (code !== 0 && (turnFailedCode !== undefined ? turnFailedCode : errorCode));
  if (failure) writeStartupFailure(failure);
  logLine(`exited ${code === null ? 'by signal' : `with code ${code}`}${failure ? ` (${failure})` : ''}`);
  const settle = Promise.allSettled(Array.from(pending));
  const deadline = new Promise(resolve => setTimeout(resolve, 3000));
  Promise.race([settle, deadline]).finally(() => process.exit(failure ? STARTUP_FAILURE_EXIT : code === null ? 1 : code));
});
