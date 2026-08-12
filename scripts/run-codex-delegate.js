#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { projectCodexEvent } = require('../delegate-activity');

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

const child = spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'ignore'], env: process.env });
let buffer = '';
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
    const projected = projectCodexEvent(event);
    if (projected && submitted < 100) {
      submitted += 1;
      const request = submitActivity(projected);
      pending.add(request);
      request.finally(() => pending.delete(request));
    }
  }
});
child.on('error', () => process.exit(1));
child.on('exit', code => {
  const settle = Promise.allSettled(Array.from(pending));
  const deadline = new Promise(resolve => setTimeout(resolve, 3000));
  Promise.race([settle, deadline]).finally(() => process.exit(code === null ? 1 : code));
});
