# Relay monitor deployment assets

These files deploy the Phase 2 monitor and the disabled-by-default Phase 3
exact-job stop control. They never expose the relay daemon.

## Secrets

Generate two independent 256-bit values. Never print or commit them:

```sh
umask 077
openssl rand -hex 32 > /path/to/local/private/agent-secret
openssl rand -hex 32 > /path/to/local/private/csrf-secret
```

Copy the agent secret to the droplet as the mode-0600
`/etc/claude-relay-monitor/agent-secret`. Store the same value in the Mac
agent's mode-0600 `agent-secret` file. Store the independent CSRF value in the
droplet's mode-0600 `/etc/claude-relay-monitor/csrf-secret`. Cloudflare's
service-token secret goes only in its separate Mac mode-0600 file.

## Cloudflare Access

Configure the human application and the more-specific agent Service Auth path
before creating DNS. Populate the Access team domain and audience values in
`web.env`. The origin validates `Cf-Access-Jwt-Assertion`; the Mac agent also
performs the independent nonce/HMAC handshake.

For the pre-Access origin verification only, install `web.env.pre-access` as
`/etc/claude-relay-monitor/web.env` and create a separate mode-0600
`/etc/claude-relay-monitor/web-password`. This fallback must be removed when
the Access values are installed.

## Deployment

After the populated environment file exists on the droplet:

```sh
./scripts/deploy-monitor-to-DO.sh
```

The script runs tests, uploads a release, installs the systemd and Nginx
configuration, verifies loopback health, and performs a pre-DNS Host-header
check. It does not create Cloudflare records or alter the relay daemon.

After creating the Mac secret files and exporting the Cloudflare service-token
client ID, install or refresh the outbound agent with:

```sh
CF_ACCESS_CLIENT_ID=replace-me ./scripts/install-monitor-agent.sh
```

## Phase 3 gate

`MONITOR_STOP_DELEGATE_ENABLED` defaults to `0` independently on the droplet
and Mac. With either side disabled, no remote mutation is accepted. Enable it
on both sides only for the synthetic exact-job acceptance test, then reinstall
the launch agent and restart the web service. The browser can supply only a
canonical job ID and a local-agent-minted, 60-second, single-use confirmation
token; it never supplies a PID, signal, executable, or command.

## Phase 4 gates

Every browser admin capability has a separate gate on the droplet and Mac
agent. All seven settings in `web.env.example` and the generated launchd plist
default to `0`. The server exposes an action only after the authenticated,
fresh agent advertises the same capability. Exact-owner and all-owner cleanup
remain separate; global message cleanup stays off until separately approved.

Enable only the capability under acceptance, refresh the launch agent, restart
the web service, complete the synthetic acceptance steps in the Phase 4 spec,
then either record the accepted state or return both gates to `0`.
