#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_PATH="${MONITOR_NODE_PATH:-$(command -v node)}"
SECRET_DIR="${MONITOR_SECRET_DIR:-$HOME/.config/claude-relay-monitor}"
LOG_DIR="${MONITOR_LOG_DIR:-$ROOT/logs}"
PLIST="$HOME/Library/LaunchAgents/com.claude-relay-monitor-agent.plist"
TEMPLATE="$ROOT/deploy/relay-monitor/com.claude-relay-monitor-agent.plist.example"
STOP_DELEGATE_ENABLED="${MONITOR_STOP_DELEGATE_ENABLED:-0}"

if [[ "$STOP_DELEGATE_ENABLED" != "0" && "$STOP_DELEGATE_ENABLED" != "1" ]]; then
  echo "MONITOR_STOP_DELEGATE_ENABLED must be 0 or 1." >&2
  exit 1
fi

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
  "$TEMPLATE" > "$temporary"

plutil -lint "$temporary"
install -m 0600 "$temporary" "$PLIST"
uid="$(id -u)"
launchctl bootout "gui/$uid/com.claude-relay-monitor-agent" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$uid" "$PLIST"
launchctl kickstart -k "gui/$uid/com.claude-relay-monitor-agent"
launchctl print "gui/$uid/com.claude-relay-monitor-agent" | sed -n '1,40p'
