#!/bin/bash
# Wake-on-message listener for an idle agent session.
#
# Re-arms relay-watch.js until real mail arrives for --for TARGET, then exits
# printing exactly one status line on stdout:
#   new-message   mail arrived (exit 0) — run relay_receive
#   timeout       --max-minutes elapsed with no mail (exit 0)
#   error: ...    relay stayed unreachable (exit 2)
#
# Intended use from Claude Code: launch via the Bash tool with
# run_in_background: true before going idle; the harness's task notification
# wakes the session when this process exits.
#
#   scripts/relay-watch-loop.sh --for CC5
#
# The --since cursor is pinned to loop start (or the given value) and passed to
# every re-arm, so mail landing in the deaf gap between one watcher exiting and
# the next subscribing still triggers an immediate ping (server backfill).
set -u

FOR=""
RELAY_URL="${RELAY_URL:-ws://localhost:9999}"
MAX_MINUTES=120
WATCH_TIMEOUT=300
SINCE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --for) FOR="$2"; shift 2 ;;
    --relay-url) RELAY_URL="$2"; shift 2 ;;
    --max-minutes) MAX_MINUTES="$2"; shift 2 ;;
    --watch-timeout) WATCH_TIMEOUT="$2"; shift 2 ;;
    --since) SINCE="$2"; shift 2 ;;
    *) echo "error: unknown argument $1"; exit 2 ;;
  esac
done

if [[ -z "$FOR" ]]; then
  echo "error: --for CLIENT_ID is required"
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -z "$SINCE" ]] && SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DEADLINE=$(( $(date +%s) + MAX_MINUTES * 60 ))
FAILURES=0

while [[ $(date +%s) -lt $DEADLINE ]]; do
  OUT="$(node "$SCRIPT_DIR/relay-watch.js" \
    --for "$FOR" --timeout "$WATCH_TIMEOUT" --since "$SINCE" \
    --relay-url "$RELAY_URL" 2>/dev/null)"
  case "$OUT" in
    new-message)
      echo "new-message"
      exit 0
      ;;
    timeout)
      FAILURES=0
      ;;
    *)
      FAILURES=$(( FAILURES + 1 ))
      if [[ $FAILURES -ge 20 ]]; then
        echo "error: relay unreachable after $FAILURES attempts (${OUT:-no output})"
        exit 2
      fi
      sleep 5
      ;;
  esac
done

echo "timeout"
exit 0
