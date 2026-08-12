'use strict';

const { spawn } = require('child_process');

function notifyDelegate({ owner, state }, runner = spawn) {
  if (process.env.RELAY_DISABLE_NOTIFICATIONS === '1') return;
  const safeState = ['started', 'completed', 'failed', 'interrupted'].includes(state) ? state : 'updated';
  const safeOwner = typeof owner === 'string' ? owner.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) : 'Codex';
  const child = runner('/usr/bin/osascript', [
    '-e', 'on run argv',
    '-e', 'display notification (item 2 of argv) with title (item 1 of argv)',
    '-e', 'end run',
    'claude-relay delegate',
    `${safeOwner}: ${safeState}. Open relay-monitor for details.`
  ], { detached: true, stdio: 'ignore' });
  if (child && typeof child.unref === 'function') child.unref();
}

module.exports = { notifyDelegate };
