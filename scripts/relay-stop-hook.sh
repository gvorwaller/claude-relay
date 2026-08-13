#!/bin/bash
# Claude Code Stop hook (asyncRewake): every session listens for relay mail
# while idle, with zero model cooperation.
#
# Configured in ~/.claude/settings.json as an async-rewake Stop hook. When a
# session ends its turn, this script keeps running in the background:
#
#   1. Works out which relay peer THIS session is: a registry entry whose
#      bridge pid hangs off one of our ancestor processes (the claude CLI).
#      No env vars, no per-project config; multiple sessions in one cwd each
#      resolve their own label.
#   2. Takes a per-label lock so repeated stops arm exactly one listener.
#   3. Watches the relay (content-free) until mail for this label arrives,
#      then exits 2 — which asyncRewake turns into waking the model, which
#      runs relay_receive and acts. Watch timeouts re-arm with a pinned
#      --since cursor, so mail landing between re-arms is never missed.
#
# Sessions with no relay bridge exit instantly. If the claude process dies,
# the listener stands down. --resolve-only prints the resolved label + anchor
# pid and exits (for testing).
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Remote Macs can run Claude without exposing their NVM directory through the
# non-interactive hook PATH.  RELAY_NODE_BIN lets the operator point this hook
# at one already-installed Node executable; it never invokes or changes NVM.
NODE_BIN="${RELAY_NODE_BIN:-node}"

REGISTRY="$HOME/claude-relay/sessions/registry.json"
WATCH="$HOME/claude-relay/scripts/relay-watch.js"
[[ -f "$REGISTRY" && -f "$WATCH" ]] || exit 0

RESOLVE_ONLY=0
[[ "${1:-}" == "--resolve-only" ]] && RESOLVE_ONLY=1

# Resolve label + owning claude pid by ancestry: hooks and MCP bridges are
# both children of the claude process, so the registry entry whose bridge
# parent appears in OUR ancestor chain names this session.
read -r ID CLAUDE_PID <<< "$(python3 - "$REGISTRY" $$ <<'PY'
import json, subprocess, sys

def ps_field(pid, field):
    try:
        return subprocess.run(["ps", "-o", f"{field}=", "-p", str(pid)],
                              capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return ""

registry_path, self_pid = sys.argv[1], sys.argv[2]
try:
    registry = json.load(open(registry_path))
except Exception:
    sys.exit(0)

ancestors = []
pid = self_pid
for _ in range(6):
    pid = ps_field(pid, "ppid")
    if not pid or pid in ("0", "1"):
        break
    ancestors.append(pid)

bridge_parents = {}
for label, info in registry.items():
    bridge_pid = info.get("pid")
    if not bridge_pid:
        continue
    parent = ps_field(bridge_pid, "ppid")
    if parent:
        bridge_parents[parent] = label

for ancestor in ancestors:
    if ancestor in bridge_parents:
        print(bridge_parents[ancestor], ancestor)
        break
PY
)"
[[ -z "${ID:-}" || -z "${CLAUDE_PID:-}" ]] && exit 0

if [[ "$RESOLVE_ONLY" == "1" ]]; then
  echo "session peer: $ID (claude pid $CLAUDE_PID)"
  exit 0
fi

# One listener per label. mkdir is the atomic acquire (check-then-write races
# two simultaneous Stop hooks into double listeners); a lock whose hook or
# claude process is dead is stale and gets taken over.
LOCK="${TMPDIR:-/tmp}/claude-relay-stop-hook-${ID}.lock"
# Unique per-run token: a lock is only ever released by the run that owns it,
# so a killed predecessor's EXIT trap can never delete its successor's lock
# (review re-check #9).
TOKEN="$$-$(date +%s)-${RANDOM}"

release_lock() {
  local held
  read -r _ _ held < "$LOCK/owner" 2>/dev/null || return 0
  [[ "${held:-}" == "$TOKEN" ]] && rm -rf "$LOCK"
}

acquire_lock() {
  mkdir "$LOCK" 2>/dev/null && return 0
  if [[ -f "$LOCK" ]]; then
    # Migration: pre-mkdir versions used a plain lock file.
    read -r LOCK_HOOK LOCK_CLAUDE < "$LOCK" 2>/dev/null || true
  else
    read -r LOCK_HOOK LOCK_CLAUDE _ < "$LOCK/owner" 2>/dev/null || true
  fi
  if [[ -n "${LOCK_HOOK:-}" && -n "${LOCK_CLAUDE:-}" ]] \
     && kill -0 "$LOCK_HOOK" 2>/dev/null && kill -0 "$LOCK_CLAUDE" 2>/dev/null; then
    return 1 # a live listener for a live session already exists
  fi
  # Move the stale lock aside atomically before reaping it: the old owner can
  # then never match its token against the live lock path.
  local stale="${LOCK}.stale.$$"
  mv "$LOCK" "$stale" 2>/dev/null || return 1
  [[ -n "${LOCK_HOOK:-}" ]] && kill "$LOCK_HOOK" 2>/dev/null
  rm -rf "$stale"
  mkdir "$LOCK" 2>/dev/null
}
acquire_lock || exit 0
echo "$$ $CLAUDE_PID $TOKEN" > "$LOCK/owner"
trap release_lock EXIT

# Millisecond precision matters: a whole-second cursor makes the freshly armed
# watcher see the message this session JUST processed (stored with ms) as
# "newer" and re-wake immediately (2026-08-05 review finding #8).
SINCE="$("$NODE_BIN" -e 'console.log(new Date().toISOString())')"
while true; do
  if ! kill -0 "$CLAUDE_PID" 2>/dev/null; then
    exit 0
  fi
  OUT="$("$NODE_BIN" "$WATCH" --for "$ID" --timeout 300 --since "$SINCE" 2>/dev/null)"
  case "$OUT" in
    new-message)
      echo "Relay mail is waiting for $ID. Run relay_receive now and act on what it says; reply to the sender via relay_send if a reply is warranted." >&2
      exit 2
      ;;
    timeout:*)
      SINCE="${OUT#timeout:}"
      ;;
    timeout)
      : # normal re-arm; SINCE stays pinned so gap mail still backfills a ping
      ;;
    *)
      sleep 15 # relay unreachable; retry gently
      ;;
  esac
done
