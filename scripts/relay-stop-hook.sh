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
#   2. Takes a per-SESSION lock (keyed by the claude pid) so repeated stops
#      arm exactly one listener per session. A live listener still watching a
#      label this session no longer holds (relay_rename, reconnect) is taken
#      over rather than left running beside a second one (td-98eecf).
#   3. Watches the relay (content-free) until mail for this label arrives,
#      then exits 2 — which asyncRewake turns into waking the model, which
#      runs relay_receive and acts. Every re-arm passes --since (the saved
#      read cursor, re-read each time), so mail landing between re-arms is
#      never missed and mail already read never re-wakes. Each re-arm also
#      re-resolves the label; if the session now holds a different one, the
#      listener exits and the next Stop arms the right label.
#
# Sessions with no relay bridge exit instantly. If the claude process dies,
# the listener stands down. --resolve-only prints the resolved label + anchor
# pid and exits (for testing).
set -u
export PATH="/Users/gaylonvorwaller/.nvm/versions/node/v24.3.0/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin"

# Remote Macs can run Claude without exposing their NVM directory through the
# non-interactive hook PATH.  RELAY_NODE_BIN lets the operator point this hook
# at one already-installed Node executable; it never invokes or changes NVM.
NODE_BIN="${RELAY_NODE_BIN:-node}"

# Seconds per watch before re-arming (and re-checking label + cursor). The
# override exists for tests; relay-watch.js clamps it to 1..300.
WATCH_TIMEOUT="${RELAY_STOP_HOOK_WATCH_TIMEOUT:-300}"

REGISTRY="$HOME/claude-relay/sessions/registry.json"
WATCH="$HOME/claude-relay/scripts/relay-watch.js"
[[ -f "$REGISTRY" && -f "$WATCH" ]] || exit 0

RESOLVE_ONLY=0
[[ "${1:-}" == "--resolve-only" ]] && RESOLVE_ONLY=1

# Resolve label + owning claude pid by ancestry: hooks and MCP bridges are
# both children of the claude process, so the registry entry whose bridge
# parent appears in OUR ancestor chain names this session. Re-run on every
# re-arm: the label can change under a running listener.
resolve_session() {
  python3 - "$REGISTRY" $$ <<'PY'
import json, subprocess, sys

def ps_field(pid, field):
    try:
        return subprocess.run(["ps", "-o", f"{field}=", "-p", str(pid)],
                              capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return ""

def same_time(a, b):
    return " ".join(str(a).split()) == " ".join(str(b).split())

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

# A registry pid only names a bridge while that bridge is alive. macOS reuses
# pids, and ended entries keep theirs (for label reclaim), so a dead
# session's pid can come back as an unrelated child of THIS claude — even as
# this hook itself. That made the hook adopt a dead peer's label and watch
# the wrong mailbox (2026-10-29: CODEX64, then CODEX237). So: skip ended
# entries; never take this hook or its own ancestors for a bridge; when the
# entry recorded its bridge's parent (pid + start time), require that exact
# parent; and resolve ties by evidence and recency, never by registry order.
own = {str(self_pid), *ancestors}
candidates = {}
for label, info in registry.items():
    if not isinstance(info, dict) or info.get("ended"):
        continue
    bridge_pid = info.get("pid")
    if not bridge_pid or str(bridge_pid) in own:
        continue
    parent = ps_field(bridge_pid, "ppid")
    if not parent:
        continue
    verified = False
    if info.get("parentPid") is not None:
        if str(info["parentPid"]) != parent:
            continue
        if info.get("parentStarted"):
            if not same_time(ps_field(parent, "lstart"), info["parentStarted"]):
                continue
            verified = True
    candidates.setdefault(parent, []).append((verified, str(info.get("started") or ""), label))

for ancestor in ancestors:
    if ancestor in candidates:
        _, _, label = max(candidates[ancestor])
        print(label, ancestor)
        break
PY
}
read -r ID CLAUDE_PID <<< "$(resolve_session)"
[[ -z "${ID:-}" || -z "${CLAUDE_PID:-}" ]] && exit 0

if [[ "$RESOLVE_ONLY" == "1" ]]; then
  echo "session peer: $ID (claude pid $CLAUDE_PID)"
  exit 0
fi

# One listener per Claude SESSION, keyed by its claude pid. A per-label lock
# let a renamed session run two listeners — the old one re-arming the
# abandoned label forever (td-98eecf). mkdir is the atomic acquire
# (check-then-write races two simultaneous Stop hooks into double listeners).
LOCK_DIR="${TMPDIR:-/tmp}"
LOCK="$LOCK_DIR/claude-relay-stop-hook-session-${CLAUDE_PID}.lock"
# Unique per-run token: a lock is only ever released by the run that owns it,
# so a killed predecessor's EXIT trap can never delete its successor's lock
# (review re-check #9).
TOKEN="$$-$(date +%s)-${RANDOM}"

release_lock() {
  local held
  read -r _ _ held _ < "$LOCK/owner" 2>/dev/null || return 0
  [[ "${held:-}" == "$TOKEN" ]] && rm -rf "$LOCK"
}

descendants() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do
    echo "$child"
    descendants "$child"
  done
}

# Stop a listener loop and its whole process tree — only if that pid still IS
# a stop-hook listener (a dead holder's pid may be reused). The tree matters:
# the loop sits in $(node relay-watch.js ...), where bash defers SIGTERM
# until the pipe closes, and the node watcher can be a grandchild (bash 3.2
# forks a subshell for the substitution). Collect first, then signal, so
# nothing is reparented away mid-walk.
stop_listener() {
  local pid="$1"
  [[ -n "$pid" && "$pid" != "$$" ]] || return 0
  [[ "$(ps -o args= -p "$pid" 2>/dev/null)" == *relay-stop-hook* ]] || return 0
  # shellcheck disable=SC2046
  kill "$pid" $(descendants "$pid") 2>/dev/null
}

# Migration: listeners started by the per-label version hold
# claude-relay-stop-hook-<label>.lock. Any of those owned by THIS session is
# now superseded by the per-session lock; stop it and reap its lock.
reap_legacy_locks() {
  local legacy hook claude
  for legacy in "$LOCK_DIR"/claude-relay-stop-hook-*.lock; do
    [[ -e "$legacy" && "$legacy" != *"-session-"* ]] || continue
    hook=""; claude=""
    if [[ -f "$legacy" ]]; then
      read -r hook claude < "$legacy" 2>/dev/null || true
    else
      read -r hook claude _ < "$legacy/owner" 2>/dev/null || true
    fi
    [[ "${claude:-}" == "$CLAUDE_PID" ]] || continue
    mv "$legacy" "${legacy}.stale.$$" 2>/dev/null || continue
    stop_listener "$hook"
    rm -rf "${legacy}.stale.$$"
  done
}

acquire_lock() {
  mkdir "$LOCK" 2>/dev/null && return 0
  local hook="" claude="" label="" attempt
  for attempt in 1 2 3; do
    read -r hook claude _ label < "$LOCK/owner" 2>/dev/null && break
    sleep 0.2 # the holder may be between mkdir and writing its owner file
  done
  if [[ -n "$hook" && -n "$claude" ]] \
     && kill -0 "$hook" 2>/dev/null && kill -0 "$claude" 2>/dev/null \
     && [[ "$label" == "$ID" ]]; then
    return 1 # a live listener for this session and label already exists
  fi
  # Stale (dead holder) or watching a label this session no longer holds:
  # move the lock aside atomically before reaping it, so the old owner can
  # never match its token against the live lock path.
  local stale="${LOCK}.stale.$$"
  mv "$LOCK" "$stale" 2>/dev/null || return 1
  stop_listener "$hook"
  rm -rf "$stale"
  mkdir "$LOCK" 2>/dev/null
}
reap_legacy_locks
acquire_lock || exit 0
echo "$$ $CLAUDE_PID $TOKEN $ID" > "$LOCK/owner"
trap release_lock EXIT

# Start from this session's LAST-READ message (the id relay_receive saved in
# sessions/read-cursors.json), not from "now": mail that landed while the
# model was mid-turn is already unread when this hook arms, and a "now"
# cursor made it invisible — the listener then waited for the NEXT message
# (2026-09-29: two CODEX1 replies sat unread; the design had assumed a
# synchronous exchange). The server's subscribe-time backfill pings at once
# if anything addressed to us is newer than the cursor (our own outbound is
# excluded). An exact message id also avoids the old whole-second re-wake
# (2026-08-05 review finding #8). No saved cursor (fresh session) or an
# unreadable file: fall back to "now" with millisecond precision, as before.
CURSORS="$HOME/claude-relay/sessions/read-cursors.json"
read_saved_cursor() {
  python3 - "$CURSORS" "$ID" <<'PY2' 2>/dev/null
import json, sys
try:
    c = json.load(open(sys.argv[1])).get(sys.argv[2], {}).get("cursor")
    print(c if isinstance(c, str) and c.strip() else "")
except Exception:
    print("")
PY2
}
SINCE="$(read_saved_cursor)"
[[ -n "$SINCE" ]] || SINCE="$("$NODE_BIN" -e 'console.log(new Date().toISOString())')"
while true; do
  if ! kill -0 "$CLAUDE_PID" 2>/dev/null; then
    exit 0
  fi
  # Superseded: another hook took the session lock over.
  read -r _ _ HELD _ < "$LOCK/owner" 2>/dev/null || HELD=""
  [[ "$HELD" == "$TOKEN" ]] || exit 0
  # Renamed: this session's bridge now holds a different label. Stand down;
  # the next Stop arms that label. An empty result (bridge mid-reconnect)
  # keeps watching the current one.
  read -r NOW_ID _ <<< "$(resolve_session)"
  if [[ -n "${NOW_ID:-}" && "$NOW_ID" != "$ID" ]]; then
    exit 0
  fi
  # The model may have read mail since this listener armed (a user prompt
  # woke it): advance to the saved cursor so read mail never re-wakes.
  SAVED="$(read_saved_cursor)"
  [[ -n "$SAVED" ]] && SINCE="$SAVED"
  OUT="$("$NODE_BIN" "$WATCH" --for "$ID" --timeout "$WATCH_TIMEOUT" --since "$SINCE" 2>/dev/null)"
  case "$OUT" in
    unknown-cursor)
      echo "Relay mail may be waiting for $ID, but its saved cursor expired. Run relay_receive with replay=true and no from/to/after filter to resync. The replay returns recent mail that may already have been handled: act only on messages you have not already seen." >&2
      exit 2
      ;;
    new-message)
      echo "Relay mail is waiting for $ID. Run relay_receive now and act on what it says; reply to the sender via relay_send if a reply is warranted." >&2
      exit 2
      ;;
    timeout:*)
      SINCE="${OUT#timeout:}"
      ;;
    timeout)
      : # normal re-arm; SINCE re-read from the saved cursor next pass
      ;;
    *)
      sleep 15 # relay unreachable; retry gently
      ;;
  esac
done
