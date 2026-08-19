#!/bin/bash
# Wake a Grok relay peer through a fresh, one-shot headless delegate.
#
# Never resume the visible Grok conversation: doing so could create two writers
# for one session. The fresh worker inherits only the registered cwd and its
# job-scoped relay capability, reads durable mail as the base identity, replies,
# submits a sanitized operator report, and exits.
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

DEFAULT_PROMPT='[Automated wake from claude-relay - no human typed this.] You are a fresh headless delegate for the relay identity named in your environment. Use the claude-relay MCP tools to receive unread durable mail addressed to that identity. Act on the request in its registered working directory and reply to the sender with relay_send when warranted. Do not rename, reclaim, or displace the foreground identity. Do not open relay_wait; the notify hook will start another delegate for later mail. Your final response must be only one JSON object with exactly these fields: "summary" (what you did and how you replied), "changes" (files or external state changed, or "None"), "verification" (an array of checks), and "replyAttempted" (true if you called relay_send, regardless of its outcome; otherwise false). Do not wrap it in a Markdown fence or add prose. Do not include hidden reasoning, secrets, or raw tool output.'
PROMPT="${ARGS[1]:-$DEFAULT_PROMPT}"

# Obtain cwd line-wise rather than evaluating registry-controlled data.
PEER_CWD="$(python3 - "$REGISTRY" "$FOR" <<'PY'
import json, sys
try:
    print((json.load(open(sys.argv[1])).get(sys.argv[2]) or {}).get("cwd") or "")
except Exception:
    print("")
PY
)"

[[ "$FOR" == GROK* ]] || { echo "$FOR -> not a Grok peer"; exit 64; }
[[ -n "$PEER_CWD" && -d "$PEER_CWD" ]] || {
  echo "error: no usable registered cwd for $FOR (cwd=$PEER_CWD)"
  exit 1
}
command -v grok >/dev/null 2>&1 || { echo "error: grok CLI not found"; exit 1; }

if [[ "$DRY_RUN" == "1" ]]; then
  echo "$FOR -> fresh Grok delegate in $PEER_CWD (foreground session stays attached)"
  exit 0
fi

export RELAY_DELEGATE_FOR="$FOR"

LAST_MESSAGE_FILE="$(mktemp -t relay-grok-lastmsg)"
chmod 600 "$LAST_MESSAGE_FILE"

node "$ROOT/scripts/run-grok-delegate.js" --last-message "$LAST_MESSAGE_FILE" -- \
  grok --no-leader --cwd "$PEER_CWD" --always-approve \
  --output-format streaming-messages-json -p "$PROMPT"
GROK_EXIT=$?

if [[ -n "${RELAY_JOB_ID:-}" && -n "${RELAY_JOB_RESULT_SECRET_FILE:-}" ]]; then
  RESULT_RECORDED=0
  for ATTEMPT in 1 2 3; do
    if node "$ROOT/scripts/submit-job-result.js" \
      --job-id "$RELAY_JOB_ID" \
      --secret-file "$RELAY_JOB_RESULT_SECRET_FILE" \
      --last-message "$LAST_MESSAGE_FILE" \
      --exit-code "$GROK_EXIT"; then
      RESULT_RECORDED=1
      break
    fi
    sleep "$ATTEMPT"
  done
  [[ "$RESULT_RECORDED" == "1" ]] || echo "note: job result submission failed; credential retained for retry"
fi
rm -f "$LAST_MESSAGE_FILE"
exit "$GROK_EXIT"
