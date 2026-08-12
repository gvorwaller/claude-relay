#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const value = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const dataRoot = value('--data-dir') || path.join(__dirname, '..', 'data');
const jobsDir = path.join(dataRoot, 'jobs');
const owner = value('--owner');
const once = args.includes('--once');
const interval = Math.max(250, Number(value('--interval')) || 1000);

const labels = {
  analyzing: 'Analyzing request',
  reading_message: 'Reading relay message',
  reading_files: 'Reading files',
  running_command: 'Running a command',
  using_tool: 'Using a tool',
  updating_files: 'Updating files',
  sending_reply: 'Sending relay reply',
  preparing_response: 'Preparing response',
  waiting: 'Waiting',
  finishing: 'Finishing delegated run',
  error: 'Codex reported an error'
};

function readJobs() {
  let names = [];
  try { names = fs.readdirSync(jobsDir).filter(name => name.endsWith('.json')); } catch {}
  return names.map(name => {
    try { return JSON.parse(fs.readFileSync(path.join(jobsDir, name), 'utf8')); } catch { return null; }
  }).filter(job => job && (!owner || job.owner === owner))
    .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))
    .slice(0, 20);
}

function age(value) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function render() {
  const jobs = readJobs();
  const lines = ['claude-relay delegate activity', `Updated ${new Date().toLocaleTimeString()}`, ''];
  if (!jobs.length) lines.push('No delegate jobs recorded.');
  for (const job of jobs) {
    const latest = Array.isArray(job.activity) && job.activity.length
      ? labels[job.activity[job.activity.length - 1].type] || 'Working'
      : null;
    lines.push(`${job.owner}  ${job.status}  ${age(job.requestedAt)} ago  from ${job.from || 'unknown'}`);
    if (latest && (job.status === 'spawned' || job.status === 'running')) lines.push(`  ${latest}`);
    for (const out of (job.outbound || [])) {
      lines.push(`  Reply to ${out.to}: ${out.delivered ? 'delivered live' : 'queued'}`);
    }
    if (job.status === 'failed' || job.status === 'interrupted' || job.status === 'exited_no_delegate') {
      lines.push(`  Ended: ${job.status}`);
    }
    lines.push('');
  }
  if (!once && process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write(`${lines.join('\n')}\n`);
}

render();
if (!once) setInterval(render, interval);
