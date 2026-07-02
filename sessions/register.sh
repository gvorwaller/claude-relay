#!/bin/bash
# Claude Relay Session Registry
# Usage: source ~/claude-relay/sessions/register.sh CC-1
#
# Registers a session ID that Claude instances can read via:
#   cat ~/claude-relay/sessions/registry.json
#   echo $CLAUDE_RELAY_SESSION_ID

# Use absolute path for reliability
SESSIONS_DIR="$HOME/claude-relay/sessions"
REGISTRY="$SESSIONS_DIR/registry.json"

# Get session ID from argument or prompt
SESSION_ID="${1:-}"
if [[ -z "$SESSION_ID" ]]; then
    echo -n "Enter session ID (e.g., CC-1, CC-2, CODEX): "
    read SESSION_ID
fi

if [[ -z "$SESSION_ID" ]]; then
    echo "Error: Session ID required"
    return 1 2>/dev/null || exit 1
fi

# Export for current shell
export CLAUDE_RELAY_SESSION_ID="$SESSION_ID"

# Initialize registry if needed
if [[ ! -f "$REGISTRY" ]]; then
    echo "{}" > "$REGISTRY"
fi

# Update registry using node (since it's available)
node -e "
const fs = require('fs');
const registry = JSON.parse(fs.readFileSync('$REGISTRY', 'utf8') || '{}');
registry['$SESSION_ID'] = {
    pid: process.ppid,
    shell_pid: $$,
    started: new Date().toISOString(),
    cwd: '$PWD',
    term: process.env.TERM_PROGRAM || 'unknown'
};
const tmpFile = '$REGISTRY.' + process.pid + '.tmp';
fs.writeFileSync(tmpFile, JSON.stringify(registry, null, 2));
fs.renameSync(tmpFile, '$REGISTRY');
"

echo "✓ Registered: CLAUDE_RELAY_SESSION_ID=$SESSION_ID"
echo "  Registry: $REGISTRY"
