#!/usr/bin/env node
'use strict';

/**
 * Codex UserPromptSubmit / Stop hook pair: make a session report what its
 * delegates did while nobody was watching.
 *
 *   UserPromptSubmit  — inject pending receipts as context, with a machine
 *                       marker listing their job ids. Injection is NOT
 *                       display, so nothing is marked reported here.
 *   Stop              — verify the finished assistant message actually
 *                       covers every injected job id. If not, block with a
 *                       correction; if yes, acknowledge them as reported.
 *
 * The two halves are deliberately asymmetric: a prompt instruction is
 * advisory, so the Stop half is the enforcement boundary. A hook that only
 * injected would let a session quietly ignore its receipts.
 *
 * Usage: relay-receipts-hook.js --event userPromptSubmit|stop
 * Hook JSON arrives on stdin; hook JSON is written to stdout.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const args = process.argv.slice(2);
const eventArg = (() => {
  const index = args.indexOf('--event');
  return index >= 0 && args[index + 1] ? args[index + 1] : null;
})();

const RELAY_URL = process.env.RELAY_URL || 'ws://localhost:9999';
const REGISTRY = path.join(os.homedir(), 'claude-relay', 'sessions', 'registry.json');
const MARKER = /<!--\s*relay-delegate-receipts:\s*([0-9a-f]{64})\s*-->/;
// Pending state between the two halves of one turn, keyed by session.
const stateDir = path.join(os.tmpdir(), 'claude-relay-receipts');

function stateFile(sessionId) {
  const safe = String(sessionId || 'default').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return path.join(stateDir, `${safe}.json`);
}

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function emit(output) {
  process.stdout.write(JSON.stringify(output || {}));
  process.exit(0);
}

/**
 * Which relay label is this session? Resolved by process ancestry against
 * the registry — the same mechanism the Claude Code stop hook uses — so no
 * per-session configuration is needed.
 */
function resolveOwner(input = {}) {
  if (process.env.RELAY_DELEGATE_FOR) return null; // a delegate must never report on itself
  // Explicit override for harnesses and for sessions whose ancestry cannot
  // be resolved. Possession of the owner capability is still required.
  if (process.env.RELAY_RECEIPTS_OWNER) return process.env.RELAY_RECEIPTS_OWNER;
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  } catch {
    return null;
  }
  if (input.session_id) {
    const exact = Object.entries(registry)
      .filter(([, info]) => info && info.codexSessionId === input.session_id)
      .map(([label]) => label);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
  }
  const { execFileSync } = require('child_process');
  const ppid = pid => {
    try {
      return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
        encoding: 'utf8', timeout: 2000
      }).trim());
    } catch {
      return null;
    }
  };
  const ancestors = [];
  let current = process.pid;
  for (let depth = 0; depth < 8; depth += 1) {
    current = ppid(current);
    if (!current || current <= 1) break;
    ancestors.push(current);
  }
  for (const [label, info] of Object.entries(registry)) {
    if (!info || !info.pid) continue;
    const bridgeParent = ppid(info.pid);
    if (bridgeParent && ancestors.includes(bridgeParent)) return label;
  }
  return null;
}

function readOwnerSecret(owner) {
  try {
    return fs.readFileSync(
      path.join(os.homedir(), 'claude-relay', 'sessions', 'owners', `${owner}.secret`),
      'utf8'
    ).trim();
  } catch {
    return null;
  }
}

function withRelay(owner, run) {
  return new Promise(resolve => {
    const ws = new WebSocket(RELAY_URL);
    const finish = result => {
      try { ws.close(); } catch {}
      resolve(result);
    };
    setTimeout(() => finish(null), 5000).unref();
    ws.on('error', () => finish(null));
    ws.on('open', () => run(ws, finish));
    ws.on('message', data => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (ws.handler) ws.handler(msg, finish);
    });
  });
}

function describe(receipt) {
  const when = receipt.completedAt ? new Date(receipt.completedAt).toLocaleString() : 'unknown time';
  const lines = [`- job ${receipt.jobId} (${receipt.status}, finished ${when})`];
  if (receipt.from) lines.push(`  woken by: ${receipt.from}`);
  if (receipt.summary) lines.push(`  it reported: ${receipt.summary}`);
  if (receipt.changes) lines.push(`  changes: ${receipt.changes}`);
  if (Array.isArray(receipt.verification) && receipt.verification.length) {
    lines.push(`  verification: ${receipt.verification.join('; ')}`);
  }
  if (receipt.outbound && receipt.outbound.length) {
    for (const out of receipt.outbound) {
      lines.push(`  SERVER-ATTESTED: replied to ${out.to}, message ${out.messageId}, `
        + `${out.delivered ? 'delivered live' : 'queued (recipient offline)'}`);
    }
  } else {
    lines.push('  SERVER-ATTESTED: no relay reply was sent');
  }
  if (receipt.status !== 'completed') {
    lines.push(`  NOTE: this run did not complete normally (${receipt.reason || receipt.status}`
      + `${receipt.exitCode !== null && receipt.exitCode !== undefined ? `, exit ${receipt.exitCode}` : ''}).`);
  }
  return lines.join('\n');
}

function writeStateAtomic(file, value) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function onUserPromptSubmit(input) {
  const owner = resolveOwner(input);
  if (!owner) emit({});
  const receipts = await withRelay(owner, (ws, finish) => {
    ws.handler = (msg, done) => {
      if (msg.type === 'receipts') done({ receipts: msg.receipts || [], digest: msg.digest });
      if (msg.type === 'error') done(null);
    };
    ws.send(JSON.stringify({ type: 'get_receipts', owner, ownerSecret: readOwnerSecret(owner) }));
  });
  if (!receipts || receipts.receipts.length === 0 || !receipts.digest) emit({});

  // The server already limits one batch to five. Only those complete facts
  // are eligible for acknowledgement; later receipts remain pending.
  const shown = receipts.receipts;
  const ids = shown.map(r => r.jobId);
  const reportLines = shown.map(r => r.reportLine);
  const turnId = input.turn_id || input.prompt_id || null;
  writeStateAtomic(stateFile(input.session_id), {
    owner,
    sessionId: input.session_id || null,
    turnId,
    ids,
    digest: receipts.digest,
    reportLines,
    correctionRequested: false
  });

  const context = [
    `While you were away, ${shown.length} delegated wake(s) ran for "${owner}" and have not been reported yet.`,
    '',
    shown.map(describe).join('\n'),
    '',
    'Before finishing this turn, include each following server-generated sentence verbatim in',
    'your visible final message. You may add a natural explanation around them. Then include the',
    'exact marker. The Stop hook acknowledges only facts that are visibly present:',
    '',
    reportLines.join('\n'),
    '',
    `<!-- relay-delegate-receipts: ${receipts.digest} -->`
  ].join('\n');

  emit({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context
    }
  });
}

async function onStop(input) {
  const file = stateFile(input.session_id);
  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    emit({}); // nothing was injected this turn
  }
  const injected = pending.ids || [];
  if (injected.length === 0) emit({});

  if (pending.sessionId && pending.sessionId !== input.session_id) emit({});
  const stopTurnId = input.turn_id || input.prompt_id || null;
  if (pending.turnId && stopTurnId && pending.turnId !== stopTurnId) emit({});

  const message = input.last_assistant_message || '';
  const match = MARKER.exec(message);
  const markerMatches = match && match[1] === pending.digest;
  const missingFacts = (pending.reportLines || []).filter(line => !message.includes(line));

  if (!markerMatches || missingFacts.length > 0) {
    // On the corrective stop_hook_active pass, do not create a loop and do
    // not acknowledge. The same receipts remain pending for the next turn.
    if (input.stop_hook_active || pending.correctionRequested) emit({});
    pending.correctionRequested = true;
    writeStateAtomic(file, pending);
    // Enforcement: the turn does not end until the work is reported.
    emit({
      decision: 'block',
      reason: `You have not visibly reported ${missingFacts.length || injected.length} delegated run(s). `
        + `Include every server-generated receipt sentence and the marker <!-- relay-delegate-receipts: ${pending.digest} -->.`
    });
  }

  // Reported: close them out. Only ids that were actually injected are ever
  // acknowledged, so a fabricated marker cannot bless unrelated jobs.
  const acked = await withRelay(pending.owner, (ws, finish) => {
    ws.handler = (msg, done) => {
      if (msg.type === 'receipts_acked') done(msg.jobIds || []);
      if (msg.type === 'error') done(null);
    };
    ws.send(JSON.stringify({
      type: 'ack_receipts',
      owner: pending.owner,
      ownerSecret: readOwnerSecret(pending.owner),
      jobIds: injected,
      digest: pending.digest,
      turnId: input.turn_id || null
    }));
  });
  try { fs.unlinkSync(file); } catch {}
  emit(acked && acked.length
    ? { systemMessage: `Relay: ${acked.length} delegate receipt(s) reported.` }
    : {});
}

const input = readStdin();
const event = eventArg || input.hook_event_name;
if (event === 'UserPromptSubmit' || event === 'userPromptSubmit') {
  onUserPromptSubmit(input);
} else if (event === 'Stop' || event === 'stop') {
  onStop(input);
} else {
  emit({});
}
