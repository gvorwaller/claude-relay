'use strict';

// Deliberately lossy projection. Never copy arbitrary strings from Codex's
// JSON event stream: they can contain reasoning, prompts, paths, commands,
// tool arguments, output, secrets, and relay message bodies.
function projectCodexEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'turn.started') return 'analyzing';
  if (event.type === 'turn.completed') return 'finishing';
  if (event.type === 'error' || event.type === 'turn.failed') return 'error';
  const item = event.item && typeof event.item === 'object' ? event.item : null;
  if (!item) return null;
  switch (item.type) {
    case 'reasoning': return 'analyzing';
    case 'command_execution': return 'running_command';
    case 'file_change': return 'updating_files';
    case 'agent_message': return 'preparing_response';
    case 'web_search': return 'using_tool';
    case 'todo_list': return 'analyzing';
    case 'mcp_tool_call': {
      // Tool names are inspected only for classification and never emitted.
      const name = String(item.tool || item.name || '').toLowerCase();
      if (name.includes('relay_receive')) return 'reading_message';
      if (name.includes('relay_send')) return 'sending_reply';
      return 'using_tool';
    }
    default: return null;
  }
}

module.exports = { projectCodexEvent };
