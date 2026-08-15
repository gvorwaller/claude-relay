#!/bin/bash
# Wake the peer behind a relay ID — generic, zero per-peer configuration.
#
# Invoked by wake-peer.sh after its single wildcard notify entry has selected
# a Codex target. The script verifies that peer and decides how to wake it:
#
#   - Codex peer (its bridge's parent is a codex process, or its label starts
#     with CODEX): resume its exact session headlessly as a delegate.
#   - Claude Code / anything else: exit 0 silently — those sessions wake via
#     their own armed relay-watch-loop.sh; there is nothing to exec.
#   - "all" (broadcast) / unknown peers: exit 0 silently.
#
# Called with RELAY_FOR set (hook) or manually: scripts/wake-codex.sh CODEX3
# [prompt]. Never uses `--last`: with several Codex instances running
# concurrently, "most recent" is the wrong session as often as not.
# Session resolution order:
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
# Exit 64 == "nothing to wake here": the caller discards the job record
# rather than leaving a receipt nobody will ever report.
[[ "$FOR" == "all" ]] && exit 64
# NOTE: keep this text apostrophe-free; macOS bash 3.2 mis-parses quotes
# inside ${var:-default}, which is also why the default lives in its own var.
DEFAULT_PROMPT="[Automated wake from the relay notify hook - no human typed this.] You have unread claude-relay mail addressed to you ($FOR). Run relay_receive, act on what it says, and reply to the sender via relay_send if a reply is warranted. Then END your turn: do not hold relay_wait open, because this hook will wake you again whenever new mail arrives. Your final response is an operator audit report constrained by the supplied JSON schema: summarize what you did, identify changes or say None, and list verification performed. Do not include hidden reasoning, secrets, or raw tool output."
PROMPT="${ARGS[1]:-$DEFAULT_PROMPT}"

read -r PEER_PID PEER_SESSION PEER_CWD <<< "$(python3 - "$REGISTRY" "$FOR" <<'PY'
import json, sys
try:
    entry = json.load(open(sys.argv[1])).get(sys.argv[2]) or {}
except Exception:
    entry = {}
print(entry.get("pid") or 0, entry.get("codexSessionId") or "-", entry.get("cwd") or "")
PY
)"

# Peer-type guard: only Codex peers get an exec wake. A live bridge is
# inspected directly (its parent process is the harness that spawned it);
# otherwise the label convention decides. Claude Code peers wake through
# their own armed relay-watch-loop.sh — exec-ing anything for them is wrong.
IS_CODEX=0
PARENT_ARGS=""
FRESH_DELEGATE=0
PEER_LIVE=0
if [[ "$PEER_PID" != "0" ]] && kill -0 "$PEER_PID" 2>/dev/null; then
  PEER_LIVE=1
  PARENT_PID="$(ps -o ppid= -p "$PEER_PID" 2>/dev/null | tr -d ' ')"
  PARENT_ARGS="$(ps -o command= -p "${PARENT_PID:-0}" 2>/dev/null)"
fi
if [[ "$PARENT_ARGS" == *[Cc]odex* || "$FOR" == CODEX* ]]; then
  IS_CODEX=1
fi
if [[ "$IS_CODEX" == "0" ]]; then
  [[ "$DRY_RUN" == "1" ]] && echo "$FOR -> not a codex peer; nothing to exec (wakes via its own watcher)"
  exit 64
fi

# Every live Codex conversation has an active thread-store writer. That is true
# for both Desktop app-server sessions and interactive CLI sessions; attempting
# `codex exec resume` against either one fails immediately with an active-writer
# conflict. Launch a fresh headless delegate in the registered working
# directory whenever the peer is live. Its job-scoped relay credential still
# makes it speak as this peer, and it never takes over the foreground session.
# Exact-session resume remains useful only after the registered peer is offline.
if [[ "$IS_CODEX" == "1" && "$PEER_LIVE" == "1" ]]; then
  FRESH_DELEGATE=1
fi

SESSION_ID=""

# 0. Best: the exact conversation the peer's bridge recorded at registration,
# persisted only when process ancestry resolved it unambiguously (finding #6).
if [[ "$PEER_SESSION" != "-" && -n "$PEER_SESSION" ]]; then
  SESSION_ID="$PEER_SESSION"
fi

# 1. Exact: which rollout file does the peer's live codex process hold open?
# A multi-session host (the ChatGPT app-server parents several bridges) holds
# several rollouts open at once — disambiguate by the peer's registered cwd.
if [[ -z "$SESSION_ID" && "$PEER_PID" != "0" ]]; then
  CODEX_PID="$(ps -o ppid= -p "$PEER_PID" 2>/dev/null | tr -d ' ')"
  if [[ -n "${CODEX_PID:-}" && "$CODEX_PID" != "0" && "$CODEX_PID" != "1" ]]; then
    ROLLOUTS="$(lsof -p "$CODEX_PID" 2>/dev/null | grep -o '/[^ ]*rollout-[^ ]*\.jsonl' | sort -u)"
    if [[ -n "$ROLLOUTS" ]]; then
      if [[ "$(echo "$ROLLOUTS" | wc -l | tr -d ' ')" == "1" ]]; then
        ROLLOUT="$ROLLOUTS"
      else
        ROLLOUT="$(python3 - "$PEER_CWD" $ROLLOUTS <<'PY'
import json, sys
cwd = sys.argv[1]
matches = []
for f in sys.argv[2:]:
    try:
        with open(f) as fh:
            payload = json.loads(fh.readline())
        payload = payload.get("payload", payload)
        if payload.get("cwd") == cwd:
            matches.append(f)
    except Exception:
        continue
# Exactly one, or nothing: two live conversations in one directory must not
# be resolved by arbitrary order (review re-check #6).
print(matches[0] if len(matches) == 1 else "")
PY
)"
      fi
      if [[ -n "$ROLLOUT" ]]; then
        SESSION_ID="$(basename "$ROLLOUT" .jsonl | sed -E 's/^rollout-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-//')"
      fi
    fi
  fi
fi

# 2. Last resort: a rollout in the peer's registered cwd -- but ONLY if it is
# unique. "Newest wins" could inject this peer's mail into a different
# conversation that happens to share the directory (review finding #6).
if [[ -z "$SESSION_ID" && -n "$PEER_CWD" ]]; then
  SESSION_ID="$(python3 - "$PEER_CWD" <<'PY'
import json, os, sys, glob
cwd = sys.argv[1]
# Scan EVERY rollout: a truncated window could make an ambiguous directory
# look unique and resume the wrong conversation (review re-check #6). Bail
# out as soon as a second match proves ambiguity.
files = glob.glob(os.path.expanduser("~/.codex/sessions/*/*/*/rollout-*.jsonl"))
matches = []
for f in files:
    try:
        with open(f) as fh:
            payload = json.loads(fh.readline())
        payload = payload.get("payload", payload)
        if payload.get("cwd") == cwd and payload.get("id"):
            matches.append(payload["id"])
            if len(matches) > 1:
                break
    except Exception:
        continue
print(matches[0] if len(matches) == 1 else "")
PY
)"
  [[ -n "$SESSION_ID" ]] && echo "note: $FOR resolved by unique cwd match (no persisted session id)"
fi

if [[ "$FRESH_DELEGATE" == "0" && -z "$SESSION_ID" ]]; then
  echo "error: no codex session found for $FOR (pid=$PEER_PID cwd=$PEER_CWD)"
  # Automation cannot reach this peer (e.g. an app conversation with no
  # CLI-resumable rollout) — fall back to telling the human, content-free.
  # FOR is passed as argv, never interpolated into AppleScript source
  # (review finding #1); the script text is a fixed constant.
  if [[ "$DRY_RUN" == "0" ]]; then
    osascript \
      -e 'on run argv' \
      -e 'display notification ("" & (item 1 of argv) & " has unread relay mail but no auto-wakeable session - poke it manually") with title ("relay: " & (item 1 of argv))' \
      -e 'end run' \
      "$FOR" 2>/dev/null
  fi
  exit 1
fi

if [[ "$DRY_RUN" == "1" ]]; then
  if [[ "$FRESH_DELEGATE" == "1" ]]; then
    echo "$FOR -> fresh codex delegate in $PEER_CWD (live foreground session stays attached)"
  else
    echo "$FOR -> codex session $SESSION_ID"
  fi
  exit 0
fi

# Delegate mode: the resumed run's relay bridge reads and answers mail AS the
# peer without owning its label, so the interactive session that holds the
# label is never displaced. The relay shows it transparently as <FOR>~wake-<pid>.
# Codex gives MCP servers a curated env (plain exports never arrive), so the
# flag is injected via config override; the bridge also detects codex-exec
# ancestry as a fallback and self-selects delegate mode.
export RELAY_DELEGATE_FOR="$FOR"
# The job capability travels as a PATH to a 0600 file, never as the secret
# itself: config overrides land in the process argv, which `ps` exposes.
CODEX_ARGS=(-c "mcp_servers.claude-relay.env.RELAY_DELEGATE_FOR=$FOR")
if [[ -n "${RELAY_JOB_TOKEN_FILE:-}" ]]; then
  CODEX_ARGS+=(-c "mcp_servers.claude-relay.env.RELAY_JOB_TOKEN_FILE=$RELAY_JOB_TOKEN_FILE")
fi

# Capture the run's final message so the job receipt can say what happened,
# rather than only that a process exited. NOT exec: we must outlive codex to
# submit the result.
LAST_MESSAGE_FILE="$(mktemp -t relay-lastmsg)"
chmod 600 "$LAST_MESSAGE_FILE"
RESULT_SCHEMA="$(dirname "${BASH_SOURCE[0]}")/delegate-result-schema.json"
if [[ "$FRESH_DELEGATE" == "1" ]]; then
  node "$(dirname "${BASH_SOURCE[0]}")/run-codex-delegate.js" -- \
    codex exec --json "${CODEX_ARGS[@]}" -C "$PEER_CWD" \
    --output-schema "$RESULT_SCHEMA" \
    --output-last-message "$LAST_MESSAGE_FILE" "$PROMPT"
else
  node "$(dirname "${BASH_SOURCE[0]}")/run-codex-delegate.js" -- \
    codex exec --json "${CODEX_ARGS[@]}" --output-schema "$RESULT_SCHEMA" \
    --output-last-message "$LAST_MESSAGE_FILE" \
    resume "$SESSION_ID" "$PROMPT"
fi
CODEX_EXIT=$?

if [[ -n "${RELAY_JOB_ID:-}" && -n "${RELAY_JOB_RESULT_SECRET_FILE:-}" ]]; then
  RESULT_RECORDED=0
  for ATTEMPT in 1 2 3; do
    if node "$(dirname "${BASH_SOURCE[0]}")/submit-job-result.js" \
      --job-id "$RELAY_JOB_ID" \
      --secret-file "$RELAY_JOB_RESULT_SECRET_FILE" \
      --last-message "$LAST_MESSAGE_FILE" \
      --exit-code "$CODEX_EXIT"; then
      RESULT_RECORDED=1
      break
    fi
    sleep "$ATTEMPT"
  done
  [[ "$RESULT_RECORDED" == "1" ]] || echo "note: job result submission failed; credential retained for retry"
fi
rm -f "$LAST_MESSAGE_FILE"
exit $CODEX_EXIT
