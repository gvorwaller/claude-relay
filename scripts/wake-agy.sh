#!/bin/bash
# Wake an AGY relay peer through a fresh, one-shot headless delegate.
#
# Never resume the visible AGY conversation: the fresh worker inherits only the
# registered cwd and its job-scoped relay capability, drains current durable
# mail, replies when warranted, submits a sanitized report, and exits.
set -u
export PATH="/Users/gaylonvorwaller/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGISTRY="${RELAY_REGISTRY:-$ROOT/sessions/registry.json}"
FOR="${RELAY_FOR:-}"
DRY_RUN=0
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--dry-run" ]]; then DRY_RUN=1; else ARGS+=("$arg"); fi
done
[[ ${#ARGS[@]} -ge 1 && -z "$FOR" ]] && FOR="${ARGS[0]}"
[[ -z "$FOR" ]] && { echo "error: peer ID required (RELAY_FOR or first argument)"; exit 2; }
[[ "$FOR" == "all" ]] && exit 64

DEFAULT_PROMPT='[Automated wake from claude-relay - no human typed this.] You are a fresh headless delegate for the relay identity named in your environment. Use the claude-relay MCP tools to receive unread durable mail addressed to that identity. Act on the request in its registered working directory and reply to the sender with relay_send when warranted. Do not rename, reclaim, or displace the foreground identity. Do not open relay_wait; the notify hook will start another delegate for later mail. Your final response must match the required JSON schema and must not include hidden reasoning, secrets, or raw tool output.'
PROMPT="${ARGS[1]:-$DEFAULT_PROMPT}"

PEER_CWD="$(python3 - "$REGISTRY" "$FOR" <<'PY'
import json, sys
try:
    print((json.load(open(sys.argv[1])).get(sys.argv[2]) or {}).get("cwd") or "")
except Exception:
    print("")
PY
)"

[[ "$FOR" == AGY* ]] || { echo "$FOR -> not an AGY peer"; exit 64; }
[[ -n "$PEER_CWD" && -d "$PEER_CWD" ]] || {
  echo "error: no usable registered cwd for $FOR (cwd=$PEER_CWD)"
  exit 1
}
command -v agy >/dev/null 2>&1 || { echo "error: agy CLI not found"; exit 1; }

if [[ "$DRY_RUN" == "1" ]]; then
  echo "$FOR -> fresh AGY delegate in $PEER_CWD (foreground session stays attached)"
  exit 0
fi

export RELAY_DELEGATE_FOR="$FOR"
RESULT_SCHEMA="$ROOT/scripts/delegate-result-schema.json"
LAST_MESSAGE_FILE="$(mktemp -t relay-agy-lastmsg)"
chmod 600 "$LAST_MESSAGE_FILE"

node "$ROOT/scripts/run-agy-delegate.js" --last-message "$LAST_MESSAGE_FILE" -- \
  agy -p "$PROMPT" --output-format stream-json --json-schema "$RESULT_SCHEMA" \
  --print-timeout 10m --dangerously-skip-permissions
AGY_EXIT=$?

if [[ -n "${RELAY_JOB_ID:-}" && -n "${RELAY_JOB_RESULT_SECRET_FILE:-}" ]]; then
  RESULT_RECORDED=0
  for ATTEMPT in 1 2 3; do
    if node "$ROOT/scripts/submit-job-result.js" \
      --job-id "$RELAY_JOB_ID" \
      --secret-file "$RELAY_JOB_RESULT_SECRET_FILE" \
      --last-message "$LAST_MESSAGE_FILE" \
      --exit-code "$AGY_EXIT"; then
      RESULT_RECORDED=1
      break
    fi
    sleep "$ATTEMPT"
  done
  [[ "$RESULT_RECORDED" == "1" ]] || echo "note: job result submission failed; credential retained for retry"
fi
rm -f "$LAST_MESSAGE_FILE"
exit "$AGY_EXIT"
