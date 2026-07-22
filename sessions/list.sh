#!/bin/bash
# One table of all Claude relay sessions with live-verified state.
# (Thin wrapper — the single source of truth is status.js)
exec node "$HOME/claude-relay/sessions/status.js" "$@"
