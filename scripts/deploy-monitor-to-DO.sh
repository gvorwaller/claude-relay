#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DROPLET="${RELAY_MONITOR_DROPLET:-root@134.199.211.199}"
APP_ROOT="/opt/claude-relay-monitor"
REVISION="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
RELEASE="$APP_ROOT/releases/$REVISION"
SCOPED_PATHS=(
  monitor-web monitor-model.js monitor-protocol.js monitor-admin.js monitor-admin-schema.js monitor-control.js runtime-status.js
  capabilities.js delegate-job-store.js package.json package-lock.json
  scripts/relay-monitor-agent.js scripts/deploy-monitor-to-DO.sh
  deploy/relay-monitor
)

if [[ -n "$(git -C "$ROOT" status --porcelain -- "${SCOPED_PATHS[@]}")" ]]; then
  echo "Refusing to deploy uncommitted relay-monitor code or deployment assets." >&2
  exit 1
fi

if [[ "${1:-}" != "--skip-tests" ]]; then
  (cd "$ROOT" && npm test)
fi

ssh "$DROPLET" "test -s /etc/claude-relay-monitor/web.env && test -s /etc/claude-relay-monitor/agent-secret && test -s /etc/claude-relay-monitor/csrf-secret" || {
  echo "Missing populated relay-monitor environment or secret files on the droplet." >&2
  exit 1
}

ssh "$DROPLET" "id relay-monitor >/dev/null 2>&1 || useradd --system --home-dir '$APP_ROOT' --shell /usr/sbin/nologin relay-monitor; mkdir -p '$RELEASE'"

rsync -az --delete \
  --include='/monitor-web/***' \
  --include='/monitor-protocol.js' \
  --include='/monitor-admin-schema.js' \
  --include='/package.json' \
  --include='/package-lock.json' \
  --exclude='*' \
  "$ROOT/" "$DROPLET:$RELEASE/"

rsync -az "$ROOT/deploy/relay-monitor/nginx.conf" "$DROPLET:/etc/nginx/sites-available/relay.gaylon.photos"
rsync -az "$ROOT/deploy/relay-monitor/relay-monitor-web.service" "$DROPLET:/etc/systemd/system/relay-monitor-web.service"

ssh "$DROPLET" bash -s -- "$RELEASE" "$APP_ROOT" <<'REMOTE'
set -euo pipefail
release="$1"
app_root="$2"
cd "$release"
npm ci --omit=dev --ignore-scripts
chown -R root:root "$release"
chmod -R go-w "$release"
chown relay-monitor:relay-monitor /etc/claude-relay-monitor/web.env
chown relay-monitor:relay-monitor /etc/claude-relay-monitor/agent-secret /etc/claude-relay-monitor/csrf-secret
chmod 0600 /etc/claude-relay-monitor/web.env /etc/claude-relay-monitor/agent-secret /etc/claude-relay-monitor/csrf-secret
ln -sfn "$release" "$app_root/current"
ln -sfn /etc/nginx/sites-available/relay.gaylon.photos /etc/nginx/sites-enabled/relay.gaylon.photos
systemctl daemon-reload
systemctl enable relay-monitor-web.service >/dev/null
nginx -t
systemctl restart relay-monitor-web.service
systemctl reload nginx
for attempt in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:3006/healthz >/dev/null; then break; fi
  if [[ "$attempt" -eq 20 ]]; then
    systemctl status relay-monitor-web.service --no-pager
    exit 1
  fi
  sleep 1
done
curl -fsS -H 'Host: relay.gaylon.photos' http://127.0.0.1/healthz
test "$(ss -ltnH 'sport = :3006' | awk '{print $4}')" = "127.0.0.1:3006"
REMOTE

echo "Relay monitor origin deployed at revision $REVISION."
echo "Phase 3 and every Phase 4 capability remain controlled by independent two-sided gates."
