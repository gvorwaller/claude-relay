#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { spawnSync } = require('child_process');
const {
  delegateJobDetail, delegateJobReportLines, healthAssessment,
  messageOwnerChoices, operatorJobRequest, operatorMessageRequest,
  operatorOwnerRepair, ownerChoices, pendingOwnerLabels,
  readJobRecords, relayTopology, restartRelay, scrollWindow, topologyLines
} = require('../monitor-control');

const args = process.argv.slice(2);
const value = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const dataRoot = value('--data-dir') || path.join(__dirname, '..', 'data');
const owner = value('--owner');
const once = args.includes('--once');
const interval = Math.max(250, Number(value('--interval')) || 1000);

const labels = {
  analyzing: 'Analyzing request', reading_message: 'Reading relay message',
  reading_files: 'Reading files', running_command: 'Running a command',
  using_tool: 'Using a tool', updating_files: 'Updating files',
  sending_reply: 'Sending relay reply', preparing_response: 'Preparing response',
  waiting: 'Waiting', finishing: 'Finishing delegated run', error: 'Codex reported an error'
};

function wrapLine(line, width) {
  if (!line || line.length <= width) return [line];
  const wrapped = [];
  let rest = line;
  while (rest.length > width) {
    let split = rest.lastIndexOf(' ', width);
    if (split < Math.floor(width / 2)) split = width;
    wrapped.push(rest.slice(0, split));
    rest = rest.slice(split).trimStart();
  }
  wrapped.push(rest);
  return wrapped;
}

function wrapped(lines, width = Math.max(40, (process.stdout.columns || 100) - 4)) {
  return lines.flatMap(line => wrapLine(String(line), width));
}

function jobs(limit = 20) {
  return readJobRecords(dataRoot)
    .filter(job => !owner || job.owner === owner)
    .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))
    .slice(0, limit);
}

function age(input) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(input)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function activityLines(limit = 20) {
  const lines = [];
  const records = jobs(limit);
  if (!records.length) return ['No delegate activity recorded.'];
  for (const job of records) {
    const latest = Array.isArray(job.activity) && job.activity.length
      ? labels[job.activity[job.activity.length - 1].type] || 'Working'
      : null;
    lines.push(`${job.owner}  ${job.status}  ${age(job.requestedAt)} ago  from ${job.from || 'unknown'}`);
    if (latest && (job.status === 'spawned' || job.status === 'running')) lines.push(`  ${latest}`);
    for (const outbound of (job.outbound || [])) {
      lines.push(`  Reply to ${outbound.to}: ${outbound.delivered ? 'delivered live' : 'queued'}`);
    }
    if (['failed', 'interrupted', 'exited_no_delegate'].includes(job.status)) lines.push(`  Ended: ${job.status}`);
    lines.push('');
  }
  return lines;
}

function healthLines() {
  const { status, assessment } = healthAssessment(dataRoot);
  const lines = [assessment.ok ? 'Overall status: HEALTHY' : 'Overall status: NEEDS ATTENTION', ''];
  for (const result of assessment.results) lines.push(`${result.level.toUpperCase().padEnd(4)}  ${result.text}`);
  if (status?.metrics) {
    lines.push('', `Delegate records: ${Number(status.metrics.jobsTotal) || 0}`,
      `Awaiting owner report: ${Number(status.metrics.jobsUnreported) || 0}`,
      `Named identities awaiting credential confirmation: ${Number(status.metrics.ownersPending) || 0}`);
    const pendingLabels = Array.isArray(status.metrics.ownersPendingLabels)
      ? status.metrics.ownersPendingLabels : [];
    if (pendingLabels.length) {
      lines.push(`  ${pendingLabels.join(', ')}`, '',
        'These identities can still connect locally through the migration fallback,',
        'but have not yet proven possession of their saved owner credential.',
        'Until confirmed, strict or remote reconnection is not ready for them.');
    }
  }
  return lines;
}

function onceLines() {
  const { status, assessment } = healthAssessment(dataRoot);
  const lines = ['claude-relay delegate activity', `Updated ${new Date().toLocaleTimeString()}`, ''];
  let alerts = status?.alerts || [];
  if (!status) {
    try { alerts = JSON.parse(fs.readFileSync(path.join(dataRoot, 'runtime-status.json'), 'utf8')).alerts || []; } catch {}
  }
  if (alerts.some(alert => alert?.code === 'job_store_at_capacity')) {
    lines.push('ALERT  Delegate job store is at capacity with retained work', '');
  }
  lines.push(...activityLines());
  if (!assessment.ok) lines.unshift('RELAY NEEDS ATTENTION', '');
  return lines;
}

if (once || !process.stdin.isTTY || !process.stdout.isTTY) {
  process.stdout.write(`${onceLines().join('\n')}\n`);
  if (!once) setInterval(() => process.stdout.write(`${onceLines().join('\n')}\n`), interval);
} else {
  const actions = [
    ['Activity', 'See current and recent delegated work.'],
    ['Health', 'See whether the relay and its safety checks are working.'],
    ['Peers and sessions', 'See connected identities and details for their live connections.'],
    ['Repair owner credentials', 'Install a credential for an identity still using local fallback.'],
    ['Restart or repair', 'Restart only the relay service; no history is deleted.'],
    ['Clean completed activity', 'Remove old finished monitor entries; active work is always kept.'],
    ['Clean message history', 'Remove durable messages for one identity or for everyone.']
  ];
  const state = {
    selected: 0, panel: 'activity', topology: null, dialog: null, notice: null,
    activityBrowsing: false, activitySelected: 0, detail: null, detailScroll: 0
  };

  function clear() { process.stdout.write('\x1b[2J\x1b[H'); }
  function crop(lines) {
    const height = Math.max(8, (process.stdout.rows || 30) - 12);
    return lines.slice(0, height);
  }
  function detailHeight() {
    // Warp renders this process inside a command block but reports the full
    // terminal height. A bounded internal viewport keeps arrow scrolling
    // deterministic instead of incorrectly deciding the whole report fits.
    return Math.max(8, Math.min(16, (process.stdout.rows || 30) - 16));
  }
  function activityListLines() {
    const records = jobs(100);
    if (!records.length) return ['No delegate activity recorded.'];
    state.activitySelected = Math.min(state.activitySelected, records.length - 1);
    const lines = [];
    records.forEach((job, index) => {
      lines.push(`${state.activityBrowsing && index === state.activitySelected ? '>' : ' '} ${job.owner}  ${job.status}  ${age(job.requestedAt)} ago  from ${job.from || 'unknown'}`);
      const latest = Array.isArray(job.activity) && job.activity.length
        ? labels[job.activity[job.activity.length - 1].type] || 'Working' : null;
      if (latest && (job.status === 'spawned' || job.status === 'running')) lines.push(`    ${latest}`);
      for (const outbound of (job.outbound || [])) lines.push(`    Reply to ${outbound.to}: ${outbound.delivered ? 'delivered live' : 'queued'}`);
    });
    return lines;
  }
  function detailLines() {
    if (!state.detail) return ['Delegate job detail is unavailable.'];
    try { state.detail = delegateJobDetail(dataRoot, state.detail.job.jobId); } catch {}
    return wrapped(delegateJobReportLines(state.detail));
  }
  function detailWindow() {
    const window = scrollWindow(detailLines(), state.detailScroll, detailHeight());
    state.detailScroll = window.offset;
    return window;
  }
  function copyDetail() {
    if (!state.detail) return;
    const report = `${delegateJobReportLines(state.detail).join('\n')}\n`;
    const copied = spawnSync('pbcopy', [], { input: report, encoding: 'utf8' });
    state.notice = copied.error || copied.status !== 0
      ? 'Could not copy the report to the clipboard.'
      : 'Copied this delegate report to the clipboard.';
  }
  function renderDialog(lines, options) {
    return ['', ...lines, '', ...options.map((option, index) =>
      `${index === state.dialog.selected ? '>' : ' '} ${option}`), '',
      'Use ↑/↓ to choose, Return to continue, or Escape to cancel.'];
  }
  function render() {
    clear();
    const { assessment } = healthAssessment(dataRoot);
    const lines = [
      'CLAUDE RELAY CONTROL CENTER',
      `${assessment.ok ? 'Healthy' : 'Needs attention'}  •  Updated ${new Date().toLocaleTimeString()}`,
      '', 'What would you like to do?'
    ];
    actions.forEach((action, index) => lines.push(
      `${index === state.selected ? '>' : ' '} ${action[0]} — ${action[1]}`));
    lines.push('', '────────────────────────────────────────────────────────────');
    if (state.notice) lines.push(state.notice, '', 'Press Escape to dismiss.', '');
    if (state.dialog?.type === 'restart') {
      lines.push(...renderDialog([
        'Restart the relay service?',
        'This does not delete messages or activity. Agent connections may briefly reconnect.'
      ], ['Restart relay now', 'Cancel']));
    } else if (state.dialog?.type === 'scope') {
      lines.push(...renderDialog([
        state.dialog.kind === 'jobs'
          ? 'Choose whose completed activity to remove.'
          : 'Choose whose durable message history to remove.',
        state.dialog.kind === 'jobs'
          ? 'Spawned and running work will not be included.'
          : 'Messages sent from or to that identity will be included.'
      ], state.dialog.options));
    } else if (state.dialog?.type === 'repair_scope') {
      lines.push(...renderDialog([
        'Choose one identity whose owner credential should be replaced.',
        'A live session briefly reconnects. An offline session confirms on its next start.'
      ], state.dialog.options));
    } else if (state.dialog?.type === 'repair_confirm') {
      const item = state.dialog.item;
      lines.push(...renderDialog([
        `Repair the owner credential for ${item.identity}?`,
        item.live
          ? 'This live session will briefly disconnect, then reconnect and confirm automatically.'
          : 'This identity is offline. Its replacement credential will be ready for its next start.',
        'Messages, activity, and the identity name are not deleted.'
      ], ['Repair this identity', 'Cancel']));
    } else if (state.dialog?.type === 'cleanup') {
      const preview = state.dialog.preview;
      const owners = Object.entries(preview.byOwner || preview.byIdentity || {})
        .map(([name, count]) => `${name}: ${count}`).join(', ') || 'none';
      lines.push(...renderDialog([
        state.dialog.kind === 'jobs'
          ? `Remove ${preview.count} completed monitor entr${preview.count === 1 ? 'y' : 'ies'}?`
          : `Remove ${preview.count} durable message${preview.count === 1 ? '' : 's'}?`,
        `Scope: ${preview.owner}. Records: ${owners}.`,
        state.dialog.kind === 'jobs'
          ? 'This cannot remove active work. Deleted history cannot be recovered from the monitor.'
          : 'This changes conversation history for both sides and cannot be undone.'
      ], ['Remove the previewed entries', 'Cancel']));
    } else {
      const title = state.panel === 'health' ? 'HEALTH DETAILS'
        : state.panel === 'topology' ? 'PEERS AND LIVE SESSIONS'
          : state.panel === 'detail' ? 'DELEGATE DETAILS' : 'DELEGATE ACTIVITY';
      const detailView = state.panel === 'detail' ? detailWindow() : null;
      const content = state.panel === 'health' ? healthLines()
        : state.panel === 'topology'
          ? (state.topology?.error ? [`Could not load live sessions: ${state.topology.error}`] : topologyLines(state.topology))
          : state.panel === 'detail' ? detailView.lines
            : activityListLines();
      lines.push(title, '', ...(state.panel === 'detail' ? content : crop(content)));
      if (state.panel === 'activity' && state.activityBrowsing) lines.push('', 'Use ↑/↓ to select a run and Return to inspect it. Escape returns to actions. Press Q to close.');
      else if (state.panel === 'detail') lines.push('',
        `Lines ${detailView.first}-${detailView.last} of ${detailView.total}`,
        'Use ↑/↓ to scroll. Press C to copy this report or Escape to return to Activity.');
      else lines.push('', 'Use ↑/↓ to choose an action and Return to open it. Press Q to close.');
    }
    process.stdout.write(`${lines.join('\n')}\n`);
  }

  function move(delta) {
    if (!state.dialog && state.panel === 'detail') {
      const current = detailWindow();
      state.detailScroll = Math.max(0, Math.min(current.maximum, current.offset + delta));
      return;
    }
    if (!state.dialog && state.panel === 'activity' && state.activityBrowsing) {
      const length = jobs(100).length;
      if (length) state.activitySelected = (state.activitySelected + delta + length) % length;
      return;
    }
    const target = state.dialog || state;
    const length = state.dialog ? state.dialog.options.length : actions.length;
    target.selected = (target.selected + delta + length) % length;
  }
  async function choose() {
    if (state.notice) { state.notice = null; return; }
    if (state.dialog?.type === 'restart') {
      if (state.dialog.selected === 0) {
        const result = restartRelay();
        state.notice = result.ok ? result.message : `Restart failed: ${result.message}`;
      }
      state.dialog = null;
      return;
    }
    if (state.dialog?.type === 'scope') {
      const choice = state.dialog.values[state.dialog.selected];
      if (choice === null) { state.dialog = null; return; }
      try {
        const kind = state.dialog.kind;
        const preview = kind === 'jobs'
          ? await operatorJobRequest(dataRoot, 'preview', { owner: choice })
          : await operatorMessageRequest(dataRoot, 'preview', { owner: choice });
        state.dialog = { type: 'cleanup', kind, selected: 1, options: ['Remove the previewed entries', 'Cancel'], preview };
      } catch (error) {
        state.dialog = null;
        state.notice = `Could not preview cleanup: ${error.message}`;
      }
      return;
    }
    if (state.dialog?.type === 'repair_scope') {
      const item = state.dialog.items[state.dialog.selected];
      if (!item) { state.dialog = null; return; }
      state.dialog = {
        type: 'repair_confirm', item, selected: 1,
        options: ['Repair this identity', 'Cancel']
      };
      return;
    }
    if (state.dialog?.type === 'repair_confirm') {
      const item = state.dialog.item;
      if (state.dialog.selected === 0) {
        try {
          await operatorOwnerRepair(dataRoot, item.identity);
          state.notice = item.live
            ? `Installed a replacement credential for ${item.identity}. Its live session is reconnecting and will confirm automatically.`
            : `Installed a replacement credential for ${item.identity}. It will confirm automatically the next time that session starts.`;
        } catch (error) {
          state.notice = `Credential repair failed: ${error.message}`;
        }
      }
      state.dialog = null;
      return;
    }
    if (state.dialog?.type === 'cleanup') {
      if (state.dialog.selected === 0) {
        const preview = state.dialog.preview;
        const kind = state.dialog.kind;
        try {
          const result = await (kind === 'jobs' ? operatorJobRequest : operatorMessageRequest)(dataRoot, 'purge', {
            owner: preview.owner, confirmation: preview.confirmation
          });
          state.notice = kind === 'jobs'
            ? `Removed ${result.purged} completed monitor entr${result.purged === 1 ? 'y' : 'ies'}. Active work was preserved.`
            : `Removed ${result.purged} durable message${result.purged === 1 ? '' : 's'}.`;
        } catch (error) {
          state.notice = `Nothing was removed: ${error.message}`;
        }
      }
      state.dialog = null;
      return;
    }
    if (!state.dialog && state.panel === 'activity' && state.activityBrowsing) {
      const selected = jobs(100)[state.activitySelected];
      if (selected?.jobId) {
        try {
          state.detail = delegateJobDetail(dataRoot, selected.jobId);
          state.detailScroll = 0;
          state.panel = 'detail';
        } catch (error) { state.notice = error.message; }
      }
      return;
    }
    if (state.selected === 0) { state.panel = 'activity'; state.activityBrowsing = true; }
    if (state.selected === 1) state.panel = 'health';
    if (state.selected === 2) {
      state.panel = 'topology';
      try { state.topology = await relayTopology(dataRoot); }
      catch (error) { state.topology = { error: error.message }; }
    }
    if (state.selected === 3) {
      const identities = pendingOwnerLabels(dataRoot);
      if (!identities.length) {
        state.notice = 'Every named identity has a confirmed owner credential. Nothing needs repair.';
      } else {
        let live = new Set();
        try { live = new Set((await relayTopology(dataRoot)).peers || []); } catch {}
        const items = identities.map(identity => ({ identity, live: live.has(identity) }));
        const labels = items.map(item => `${item.identity}${item.live ? ' (live; will reconnect)' : ' (offline)'}`);
        state.dialog = {
          type: 'repair_scope', items: [...items, null], selected: labels.length,
          options: [...labels, 'Cancel']
        };
      }
    }
    if (state.selected === 4) state.dialog = { type: 'restart', selected: 1, options: ['Restart relay now', 'Cancel'] };
    if (state.selected === 5 || state.selected === 6) {
      const kind = state.selected === 5 ? 'jobs' : 'messages';
      const owners = kind === 'jobs' ? ownerChoices(dataRoot) : messageOwnerChoices(dataRoot);
      const optionLabels = [...owners.map(name => `${name} only`), 'All identities', 'Cancel'];
      state.dialog = { type: 'scope', kind, selected: optionLabels.length - 1, options: optionLabels, values: [...owners, 'all', null] };
    }
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('keypress', (_text, key = {}) => {
    if (key.ctrl && key.name === 'c' || key.name === 'q') process.exit(0);
    if (state.panel === 'detail' && key.name === 'c') copyDetail();
    else if (key.name === 'up') move(-1);
    else if (key.name === 'down') move(1);
    else if (key.name === 'return') void choose().then(render);
    else if (key.name === 'escape') {
      if (state.notice) state.notice = null;
      else if (state.dialog) state.dialog = null;
      else if (state.panel === 'detail') { state.panel = 'activity'; state.activityBrowsing = true; state.detail = null; state.detailScroll = 0; }
      else if (state.panel === 'activity' && state.activityBrowsing) state.activityBrowsing = false;
    }
    render();
  });
  process.on('exit', () => { try { process.stdin.setRawMode(false); } catch {} });
  process.stdout.on('resize', render);
  render();
  setInterval(() => { if (!state.dialog && !state.notice) render(); }, interval);
}
