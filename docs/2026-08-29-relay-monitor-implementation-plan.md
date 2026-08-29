# Relay Monitor Implementation and Deployment Plan

Date: 2026-08-29

Task: `td-f5bce2`

Target: `https://relay.gaylon.photos`

## Initial state

- `relay.gaylon.photos` has no DNS record.
- The shared DigitalOcean droplet is `134.199.211.199`.
- The droplet runs Node 22 and Nginx; ports 3001 through 3005 are occupied.
- The relay monitor web service will bind only to `127.0.0.1:3006`.
- Existing droplet sites use Cloudflare Flexible TLS with an HTTP origin.
- The terminal monitor remains supported. The relay daemon remains loopback-only
  on the Mac and is not moved or exposed.

## Implementation sequence

### 1. Complete the deployable read-only application

1. Complete the transport-neutral, sanitized shared monitor model.
2. Add complete snapshot, identity, and delegate-detail projections.
3. Build `relay-monitor-web`, listening only on `127.0.0.1:3006`.
4. Build the outbound Mac `relay-monitor-agent`.
5. Implement the versioned WebSocket protocol, nonce/HMAC authentication,
   sequence validation, heartbeat, bounded reconnect, and full snapshot
   replacement.
6. Implement authenticated snapshot/detail APIs, SSE browser updates, CSRF
   protection, no-store responses, and a responsive read-only UI.
7. Add data-leak, authentication, sequence-gap, reconnect, and browser-session
   tests.
8. Keep all mutating actions disabled. Exact stuck-delegate termination is a
   separately gated Phase 3 feature.

### 2. Add repository-owned deployment assets

1. Use `/opt/claude-relay-monitor` as the droplet application directory.
2. Run the web service as a dedicated unprivileged `relay-monitor` user.
3. Add a hardened `relay-monitor-web.service` systemd unit.
4. Store deployment configuration in a mode-0600 environment file and each
   secret in its own mode-0600 file, all outside Git.
5. Add an Nginx vhost for `relay.gaylon.photos` that proxies to
   `127.0.0.1:3006`, supports the agent WebSocket, disables buffering for SSE,
   and adds the required security headers.
6. Add a Mac `launchd` plist template for the outbound agent, with secrets held
   in mode-0600 files outside the repository.
7. Add a repeatable deploy script with local tests, remote health checks, and
   pre-DNS validation.

### 3. Install and verify the origin before DNS

1. Deploy the service and static UI to the droplet.
2. Install the systemd unit and Nginx vhost.
3. Run `nginx -t`, reload Nginx, and verify the service is bound only to
   `127.0.0.1:3006`.
4. Test the public hostname against the droplet IP before DNS using a pinned
   host resolution.
5. Verify that the web service and logs retain no relay message bodies, prompts,
   reasoning, commands, tool payloads, secrets, or arbitrary Mac paths.

### 4. Configure Cloudflare Access

1. Create a human Access application for `relay.gaylon.photos/*`, allowing only
   the operator's identity.
2. Create a more-specific Service Auth application or policy for the agent
   WebSocket path, allowing only a dedicated monitor-agent service token.
3. Configure the Mac agent to provide `CF-Access-Client-Id` and
   `CF-Access-Client-Secret` headers on its WebSocket upgrade.
4. Retain the separate nonce-bound monitor-agent HMAC handshake; do not reuse
   Cloudflare, relay-owner, browser, SSH, or admin credentials.
5. Validate Cloudflare's `Cf-Access-Jwt-Assertion` at the origin so a direct-IP
   request with a forged Host header cannot bypass Access.
6. Confirm Cloudflare WebSocket support is enabled and bypass caching for the
   entire monitor hostname.

### 5. Add DNS last

Create this proxied Cloudflare record only after the origin passes its tests:

| Field | Value |
| --- | --- |
| Type | `A` |
| Name | `relay` |
| Address | `134.199.211.199` |
| Proxy status | Proxied |
| TTL | Auto |

Then verify public HTTPS, Access authentication, API no-store headers, SSE, and
the outbound agent connection.

### 6. Complete live read-only acceptance

1. The browser loads through Access at desktop and phone widths.
2. Browser health, identities, and activity agree with `relay-monitor --once`
   for the same observation time.
3. A synthetic delegate appears within ten seconds.
4. Agent disconnection marks state stale after 30 seconds and offline after 60
   seconds without changing relay operation.
5. Agent reconnection replaces stale state without duplicate jobs.
6. Droplet state and logs contain none of the forbidden fields or values.

After the read-only deployment has been observed successfully, implement Phase
3 exact stuck-delegate preview and confirmation as a separate disabled-by-
default rollout.

### 7. Build and roll out Phase 3 separately

1. Add a strict `preview_request` / `preview_result` and `confirm_request` /
   `action_result` protocol allowlist.
2. Mint the confirmation token only on the Mac. Bind it to the exact job,
   owner, active status, process-group liveness, and previewed job state; expire
   it after 60 seconds and consume it before attempting the mutation.
3. Reuse `operatorTerminateDelegate` so the relay performs its existing exact
   process-group termination, interrupted-state transition, audit retention,
   and durable-mail preservation.
4. Require browser authentication and CSRF on both action endpoints. Treat a
   disconnect or timeout after confirmation as an unknown result and never
   retry automatically.
5. Gate both the web broker and Mac executor with
   `MONITOR_STOP_DELEGATE_ENABLED=0` by default.
6. Prove expiry, replay rejection, state-change rejection, cross-job binding,
   exact termination, result reconciliation, and forbidden-data exclusion in
   isolated tests.
7. Deploy the new code with the gate off. Enable both sides only for a
   synthetic stuck delegate, complete the live preview/stop/replay tests, then
   choose whether to leave the production control enabled.

## Deployment status — 2026-08-29

Phase 2 is live at `https://relay.gaylon.photos` behind Cloudflare Access. The
proxied DNS record, path-scoped agent Service Auth application, independent
agent HMAC, loopback-only droplet origin, systemd service, Nginx proxy, and Mac
launch agent are active. Live browser acceptance showed a fresh connected
snapshot, healthy relay status, all eight checks passing, six recent jobs, and
twelve identities. Superseded setup credentials and the pre-Access password
were removed before Phase 3 work began.
