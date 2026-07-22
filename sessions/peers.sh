#!/bin/bash
# Connected relay sessions only — same table as claude-sessions, filtered.
# (Thin wrapper — the single source of truth is status.js)
exec node "$HOME/claude-relay/sessions/status.js" --connected "$@"
