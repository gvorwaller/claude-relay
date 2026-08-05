#!/bin/bash
# Wake the specific Codex session behind a relay peer ID.
#
# Called from a notify.json exec hook with RELAY_FOR set (e.g. CODEX3), or
# manually: scripts/wake-codex.sh CODEX3 [prompt]. Never uses `--last`:
# with several Codex instances running concurrently, "most recent" is the
# wrong session as often as not. Resolution order:
#
#   1. Exact: registry pid (the peer's MCP bridge) -> parent codex process ->
#      the rollout-*.jsonl it holds open -> session id.
#   2. Fallback: newest rollout file whose recorded cwd matches the peer's
#      registered cwd (covers a codex process that exited but can be resumed).
#
# --dry-run prints the resolved session id and exits without resuming.
set -u
export PATH="/Users/gaylonvorwaller/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

REGISTRY="${RELAY_REGISTRY:-$HOME/claude-relay/sessions/registry.json}"
FOR="${RELAY_FOR:-}"
DRY_RUN=0
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--dry-run" ]]; then DRY_RUN=1; else ARGS+=("$arg"); fi
done
[[ ${#ARGS[@]} -ge 1 && -z "$FOR" ]] && FOR="${ARGS[0]}"
[[ -z "$FOR" ]] && { echo "error: peer ID required (RELAY_FOR or first argument)"; exit 2; }
# NOTE: keep this text apostrophe-free; macOS bash 3.2 mis-parses quotes
# inside ${var:-default}, which is also why the default lives in its own var.
DEFAULT_PROMPT="[Automated wake from the relay notify hook - no human typed this.] You have unread claude-relay mail addressed to you ($FOR). Run relay_receive, act on what it says, and reply to the sender via relay_send if a reply is warranted. Then END your turn: do not hold relay_wait open, because this hook will wake you again whenever new mail arrives."
PROMPT="${ARGS[1]:-$DEFAULT_PROMPT}"

read -r PEER_PID PEER_CWD <<< "$(python3 - "$REGISTRY" "$FOR" <<'PY'
import json, sys
try:
    entry = json.load(open(sys.argv[1])).get(sys.argv[2]) or {}
except Exception:
    entry = {}
print(entry.get("pid") or 0, entry.get("cwd") or "")
PY
)"

SESSION_ID=""

# 1. Exact: which rollout file does the peer's live codex process hold open?
if [[ "$PEER_PID" != "0" ]]; then
  CODEX_PID="$(ps -o ppid= -p "$PEER_PID" 2>/dev/null | tr -d ' ')"
  if [[ -n "${CODEX_PID:-}" && "$CODEX_PID" != "0" && "$CODEX_PID" != "1" ]]; then
    ROLLOUT="$(lsof -p "$CODEX_PID" 2>/dev/null | grep -o '/[^ ]*rollout-[^ ]*\.jsonl' | head -1)"
    if [[ -n "$ROLLOUT" ]]; then
      SESSION_ID="$(basename "$ROLLOUT" .jsonl | sed -E 's/^rollout-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-//')"
    fi
  fi
fi

# 2. Fallback: newest session recorded in the peer's registered cwd.
if [[ -z "$SESSION_ID" && -n "$PEER_CWD" ]]; then
  SESSION_ID="$(python3 - "$PEER_CWD" <<'PY'
import json, os, sys, glob
cwd = sys.argv[1]
files = glob.glob(os.path.expanduser("~/.codex/sessions/*/*/*/rollout-*.jsonl"))
files.sort(key=os.path.getmtime, reverse=True)
for f in files[:200]:
    try:
        with open(f) as fh:
            meta = json.loads(fh.readline())
        payload = meta.get("payload", meta)
        if payload.get("cwd") == cwd:
            print(payload.get("id") or "")
            break
    except Exception:
        continue
PY
)"
fi

if [[ -z "$SESSION_ID" ]]; then
  echo "error: no codex session found for $FOR (pid=$PEER_PID cwd=$PEER_CWD)"
  exit 1
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "$FOR -> codex session $SESSION_ID"
  exit 0
fi

# Delegate mode: the resumed run's relay bridge reads and answers mail AS the
# peer without owning its label, so the interactive session that holds the
# label is never displaced. The relay shows it transparently as <FOR>~wake-<pid>.
export RELAY_DELEGATE_FOR="$FOR"
exec codex exec resume "$SESSION_ID" "$PROMPT"
