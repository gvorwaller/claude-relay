#!/bin/bash
# Route one relay wake to the correct harness-specific headless delegate.
#
# This is the single wildcard notify hook. Routing happens before a delegate
# starts, so one inbound message creates exactly one auditable job. Harnesses
# without a safe headless wake path return 64 and keep their own watcher path.
set -u
export PATH="/Users/gaylonvorwaller/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGISTRY="${RELAY_REGISTRY:-$ROOT/sessions/registry.json}"
FOR="${RELAY_FOR:-}"
ARGS=("$@")

if [[ -z "$FOR" ]]; then
  for arg in "${ARGS[@]}"; do
    [[ "$arg" == "--dry-run" ]] && continue
    FOR="$arg"
    break
  done
fi
[[ -z "$FOR" ]] && { echo "error: peer ID required (RELAY_FOR or first argument)"; exit 2; }
[[ "$FOR" == "all" ]] && exit 64

read -r PEER_PID <<< "$(python3 - "$REGISTRY" "$FOR" <<'PY'
import json, sys
try:
    entry = json.load(open(sys.argv[1])).get(sys.argv[2]) or {}
except Exception:
    entry = {}
print(entry.get("pid") or 0)
PY
)"

PARENT_ARGS=""
if [[ "$PEER_PID" != "0" ]] && kill -0 "$PEER_PID" 2>/dev/null; then
  PARENT_PID="$(ps -o ppid= -p "$PEER_PID" 2>/dev/null | tr -d ' ')"
  PARENT_ARGS="$(ps -o command= -p "${PARENT_PID:-0}" 2>/dev/null)"
fi

if [[ "$PARENT_ARGS" == *[Cc]odex* || "$FOR" == CODEX* ]]; then
  if [[ ${#ARGS[@]} -gt 0 ]]; then
    exec "$ROOT/scripts/wake-codex.sh" "${ARGS[@]}"
  else
    exec "$ROOT/scripts/wake-codex.sh"
  fi
fi
if [[ "$PARENT_ARGS" == *[Gg]rok* || "$FOR" == GROK* ]]; then
  if [[ ${#ARGS[@]} -gt 0 ]]; then
    exec "$ROOT/scripts/wake-grok.sh" "${ARGS[@]}"
  else
    exec "$ROOT/scripts/wake-grok.sh"
  fi
fi
if [[ "$PARENT_ARGS" == *agy* || "$FOR" == AGY* ]]; then
  if [[ ${#ARGS[@]} -gt 0 ]]; then
    exec "$ROOT/scripts/wake-agy.sh" "${ARGS[@]}"
  else
    exec "$ROOT/scripts/wake-agy.sh"
  fi
fi

# Claude Code sessions use relay-stop-hook.sh; unknown harnesses have no safe
# process to launch. Exit 64 tells NotifyHooks to discard the provisional job.
exit 64
