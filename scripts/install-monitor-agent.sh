#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_PATH="${MONITOR_NODE_PATH:-$(command -v node)}"
SECRET_DIR="${MONITOR_SECRET_DIR:-$HOME/.config/claude-relay-monitor}"
LOG_DIR="${MONITOR_LOG_DIR:-$ROOT/logs}"
PLIST="$HOME/Library/LaunchAgents/com.claude-relay-monitor-agent.plist"
TEMPLATE="$ROOT/deploy/relay-monitor/com.claude-relay-monitor-agent.plist.example"
STOP_DELEGATE_ENABLED="${MONITOR_STOP_DELEGATE_ENABLED:-0}"
ADMIN_RESTART_ENABLED="${MONITOR_ADMIN_RESTART_ENABLED:-0}"
ADMIN_ACTIVITY_CLEANUP_ENABLED="${MONITOR_ADMIN_ACTIVITY_CLEANUP_ENABLED:-0}"
ADMIN_CREDENTIAL_REPAIR_ENABLED="${MONITOR_ADMIN_CREDENTIAL_REPAIR_ENABLED:-0}"
ADMIN_IDENTITY_REMOVAL_ENABLED="${MONITOR_ADMIN_IDENTITY_REMOVAL_ENABLED:-0}"
ADMIN_MESSAGE_CLEANUP_ENABLED="${MONITOR_ADMIN_MESSAGE_CLEANUP_ENABLED:-0}"
ADMIN_ACTIVITY_CLEANUP_ALL_ENABLED="${MONITOR_ADMIN_ACTIVITY_CLEANUP_ALL_ENABLED:-0}"
ADMIN_MESSAGE_CLEANUP_ALL_ENABLED="${MONITOR_ADMIN_MESSAGE_CLEANUP_ALL_ENABLED:-0}"

gate_names=(
  STOP_DELEGATE_ENABLED ADMIN_RESTART_ENABLED ADMIN_ACTIVITY_CLEANUP_ENABLED
  ADMIN_CREDENTIAL_REPAIR_ENABLED ADMIN_IDENTITY_REMOVAL_ENABLED
  ADMIN_MESSAGE_CLEANUP_ENABLED ADMIN_ACTIVITY_CLEANUP_ALL_ENABLED
  ADMIN_MESSAGE_CLEANUP_ALL_ENABLED
)
for gate_name in "${gate_names[@]}"; do
  gate_value="${!gate_name}"
  if [[ "$gate_value" != "0" && "$gate_value" != "1" ]]; then
    echo "$gate_name must be 0 or 1." >&2
    exit 1
  fi
done

for file in "$SECRET_DIR/agent-secret" "$SECRET_DIR/cf-access-client-secret"; do
  if [[ ! -s "$file" ]]; then
    echo "Missing private credential file: $file" >&2
    exit 1
  fi
  mode="$(stat -f '%Lp' "$file")"
  if (( (8#$mode & 8#077) != 0 )); then
    echo "Credential file must be mode 0600: $file" >&2
    exit 1
  fi
done

if [[ -z "${CF_ACCESS_CLIENT_ID:-}" ]]; then
  echo "Set CF_ACCESS_CLIENT_ID to the monitor-agent Cloudflare service-token client ID." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
temporary="$(mktemp "${TMPDIR:-/tmp}/relay-monitor-agent.XXXXXX")"
trap 'rm -f "$temporary"' EXIT

sed \
  -e "s|__NODE_PATH__|$NODE_PATH|g" \
  -e "s|__REPO_PATH__|$ROOT|g" \
  -e "s|__SECRET_DIR__|$SECRET_DIR|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  -e "s|__CF_ACCESS_CLIENT_ID__|$CF_ACCESS_CLIENT_ID|g" \
  -e "s|__STOP_DELEGATE_ENABLED__|$STOP_DELEGATE_ENABLED|g" \
  -e "s|__ADMIN_RESTART_ENABLED__|$ADMIN_RESTART_ENABLED|g" \
  -e "s|__ADMIN_ACTIVITY_CLEANUP_ENABLED__|$ADMIN_ACTIVITY_CLEANUP_ENABLED|g" \
  -e "s|__ADMIN_CREDENTIAL_REPAIR_ENABLED__|$ADMIN_CREDENTIAL_REPAIR_ENABLED|g" \
  -e "s|__ADMIN_IDENTITY_REMOVAL_ENABLED__|$ADMIN_IDENTITY_REMOVAL_ENABLED|g" \
  -e "s|__ADMIN_MESSAGE_CLEANUP_ENABLED__|$ADMIN_MESSAGE_CLEANUP_ENABLED|g" \
  -e "s|__ADMIN_ACTIVITY_CLEANUP_ALL_ENABLED__|$ADMIN_ACTIVITY_CLEANUP_ALL_ENABLED|g" \
  -e "s|__ADMIN_MESSAGE_CLEANUP_ALL_ENABLED__|$ADMIN_MESSAGE_CLEANUP_ALL_ENABLED|g" \
  "$TEMPLATE" > "$temporary"

plutil -lint "$temporary"
install -m 0600 "$temporary" "$PLIST"
uid="$(id -u)"
launchctl bootout "gui/$uid/com.claude-relay-monitor-agent" >/dev/null 2>&1 || true
loaded=0
for attempt in 1 2 3 4 5; do
  if launchctl bootstrap "gui/$uid" "$PLIST" >/dev/null 2>&1; then
    loaded=1
    break
  fi
  sleep 1
done
if [[ "$loaded" != "1" ]]; then
  echo "Could not bootstrap com.claude-relay-monitor-agent after launchd unload." >&2
  exit 1
fi
launchctl kickstart -k "gui/$uid/com.claude-relay-monitor-agent"
launchctl print "gui/$uid/com.claude-relay-monitor-agent" | sed -n '1,40p'
