#!/bin/bash
# List registered Claude sessions
# Usage: ~/claude-relay/sessions/list.sh

# Use absolute path for reliability
REGISTRY="$HOME/claude-relay/sessions/registry.json"

if [[ ! -f "$REGISTRY" ]]; then
    echo "No sessions registered yet."
    exit 0
fi

echo "=== Registered Claude Sessions ==="
echo ""

node -e "
const fs = require('fs');
const registry = JSON.parse(fs.readFileSync('$REGISTRY', 'utf8') || '{}');
const entries = Object.entries(registry);

if (entries.length === 0) {
    console.log('No sessions registered.');
} else {
    entries.forEach(([id, info]) => {
        const started = new Date(info.started).toLocaleString();
        console.log(\`  \${id.padEnd(10)} PID: \${String(info.pid).padEnd(6)} Started: \${started}\`);
        if (info.cwd) console.log(\`             CWD: \${info.cwd}\`);
    });
}
"
echo ""
