const test = require('node:test');
const assert = require('node:assert/strict');
const { projectCodexEvent } = require('../delegate-activity');

test('Codex JSON events project to content-free activity categories', () => {
  assert.equal(projectCodexEvent({
    type: 'item.completed',
    item: { type: 'command_execution', command: 'cat /private/key', aggregated_output: 'secret' }
  }), 'running_command');
  assert.equal(projectCodexEvent({
    type: 'item.started',
    item: { type: 'mcp_tool_call', name: 'relay_send', arguments: { content: 'secret body' } }
  }), 'sending_reply');
  assert.equal(projectCodexEvent({ type: 'unknown', prompt: 'secret' }), null);
});
