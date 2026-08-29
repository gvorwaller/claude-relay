# Browser Relay Monitor Specification

Date: 2026-08-26

Status: Proposed

Priority: P1

## Summary

Build a single-user browser version of `relay-monitor` whose public web service
runs on the DigitalOcean droplet. The browser UI presents relay health, live
identities, delegated work, and delegate audit details, and supports the same
carefully confirmed operator actions as the terminal control center.

This is feasible, but the droplet cannot directly replace the local monitor.
The relay daemon, job records, process trees, and `launchd` controls live on the
Mac relay host. A small local monitor agent must therefore maintain an outbound,
authenticated connection to the droplet. The droplet hosts the web application;
the local agent remains the authority for observation and control.

The design must not expose the relay WebSocket port, the Mac filesystem, or an
SSH listener to the public internet.

## Goals

- View current and recent delegate activity from a phone or desktop browser.
- Make a stalled delegate obvious by showing both status and last-activity age.
- View the same health assessment and live identity/session facts used by the
  terminal monitor.
- Inspect a selected delegate run without displaying hidden model reasoning,
  raw tool arguments, command output, or secrets.
- Stop an exact stuck delegate through a preview and explicit confirmation.
- Eventually expose the remaining terminal control-center actions without
  weakening their current safety rules.
- Keep the current terminal monitor and CLI fully functional.

## Non-goals

- Moving the relay daemon or its durable message journal to the droplet.
- Making relay port 9999 publicly reachable.
- General multi-user administration or role-based access in the first release.
- A browser chat client for sending arbitrary relay messages.
- Remote shell, file browsing, arbitrary command execution, or log download.
- Persisting message bodies, secrets, raw prompts, reasoning, tool inputs, tool
  outputs, or arbitrary file paths on the droplet.

## Operator experience

### Overview

The default page shows four compact sections:

1. **Relay health** — Healthy, Needs attention, or Offline, with the time of the
   most recent local-agent heartbeat.
2. **Active work** — running/spawned delegate jobs first, including owner,
   requester, elapsed time, latest sanitized activity, and last-activity age.
3. **Recent work** — completed, failed, and interrupted jobs in reverse time
   order.
4. **Identities** — live/offline identities, host, working directory basename,
   connection source, and credential warnings.

The page updates without manual refresh. A disconnected browser reconnects and
loads a fresh snapshot rather than replaying an unbounded event stream.

### Stalled-work presentation

Running is not treated as proof of progress. Every active job shows:

- total run age;
- time since its last sanitized activity;
- current process-liveness result from the relay host;
- a neutral warning after 10 minutes without activity; and
- a strong "Possibly stuck" warning after 20 minutes without activity.

These thresholds are display hints, not automatic termination rules. The UI
must not stop work without operator confirmation.

### Delegate detail

Selecting a run shows:

- job ID, owner, requester, start/end times, and terminal status;
- sanitized activity timeline;
- independently recorded outbound-delivery facts;
- bounded error details;
- the delegate's constrained summary, changes, and verification results; and
- whether the local process group is still alive.

Incoming and outgoing message bodies are excluded from the first release. A
later release may fetch them on demand from the Mac without persisting or
logging them on the droplet, but only after a separate privacy review.

### Stop stuck delegate

The action is available only for a job that the local agent currently reports
as active. Selecting it returns a preview containing the exact job ID, owner,
process-group liveness, and consequences. Confirmation must include a
short-lived, single-use token bound to that preview.

After confirmation, the local agent uses the existing exact-job termination
path. It preserves the audit record and durable mail and reports the resulting
terminal state. The browser never supplies a PID, signal, executable, or shell
command.

## Architecture

```text
Browser
   |
   | HTTPS + authenticated session
   v
DigitalOcean droplet
   reverse proxy / TLS
   relay-monitor-web
      |  snapshots, events, command envelopes
      |  no raw relay store and no process authority
      v
Outbound authenticated WSS connection
      ^
      |
Mac relay host
   relay-monitor-agent
      |
      +-- monitor-control.js / runtime-status.js
      +-- local data/jobs and session registry
      +-- exact local service and process-group controls
```

### Droplet service: `relay-monitor-web`

Responsibilities:

- serve the HTML/CSS/JavaScript application;
- authenticate the human operator;
- accept one authenticated local-agent connection;
- retain only the latest sanitized snapshot and a small bounded in-memory event
  buffer;
- proxy fixed, schema-validated operator requests to the local agent;
- maintain an append-only metadata audit of operator actions; and
- expose `/healthz` without revealing relay details.

It has no filesystem access to the Mac and no generic command endpoint.

### Mac service: `relay-monitor-agent`

Responsibilities:

- connect outward to the droplet over WSS and automatically reconnect with
  bounded exponential backoff;
- reuse the monitor's existing model and control functions rather than parse
  terminal output;
- publish a complete sanitized snapshot on connect and small updates afterward;
- validate every command against a fixed allowlist and JSON schema;
- create local preview/confirmation tokens for mutating actions;
- execute exact existing monitor-control operations locally; and
- publish the verified result and refreshed snapshot.

The agent runs under `launchd` as the same local user that owns the relay. Its
connection failure must not affect the relay daemon or terminal monitor.

### Shared monitor model

Before adding either service, extract the terminal monitor's read model into a
transport-neutral module. Terminal and browser views must consume the same:

- health assessment;
- job ordering and sanitized activity labels;
- job-detail projection;
- identity/session topology;
- action availability rules; and
- preview and confirmation behavior.

There must not be a second implementation of the relay's operational rules in
the browser.

## Transport and protocol

Use versioned JSON messages over one WSS connection initiated by the Mac:

```json
{
  "version": 1,
  "type": "snapshot",
  "sequence": 42,
  "generatedAt": "2026-08-26T17:30:00.000Z",
  "payload": {}
}
```

Required message types:

- `agent_hello`
- `agent_heartbeat`
- `snapshot`
- `event`
- `preview_request`
- `preview_result`
- `confirm_request`
- `action_result`
- `protocol_error`

Each agent-to-droplet message carries a monotonically increasing sequence for
the current connection. Commands carry a random request ID. Mutating
confirmations carry a local-agent-minted token that expires after 60 seconds,
is bound to the action, target, and previewed state, and can be consumed once.

The browser does not connect to the local agent directly. Browser updates use
Server-Sent Events or a web WebSocket owned by the droplet service. SSE is the
preferred first implementation because browser traffic is primarily one-way
and commands already use ordinary authenticated HTTP requests.

## Security model

### Human authentication

The public endpoint requires HTTPS and single-user authentication. Preferred
deployment is an identity-aware reverse proxy such as Cloudflare Access. If
that is unavailable, the application must provide a high-entropy credential,
rate-limited login, and a `Secure`, `HttpOnly`, `SameSite=Strict` session cookie.

Every state-changing HTTP request also requires a CSRF token. Authentication
secrets live only in droplet environment/service configuration, never in Git.

### Agent authentication

Provision a separate 256-bit monitor-agent secret on the Mac and droplet. Use
it only to authenticate the WSS agent connection through a nonce-bound HMAC
handshake. Do not reuse `admin.secret`, relay owner credentials, SSH keys, or a
browser credential.

The droplet accepts only one active agent for the configured installation ID.
Secret comparison is constant-time. Authentication failures are rate-limited
and logged without credentials.

### Authorization and command safety

- The droplet sends action names and opaque IDs only.
- The local agent owns the allowlist and resolves the job/service target.
- The local agent rejects unknown, stale, replayed, or state-mismatched
  confirmations.
- No request can contain a shell command, signal, path, PID, or service label.
- Cleanup, identity removal, service restart, and credential repair remain out
  of the first release even though the terminal monitor supports them.
- The local agent records attempted and completed actions before returning the
  result.

### Data minimization

The droplet may retain:

- sanitized job metadata and activity categories;
- health results;
- identity labels and coarse connection metadata;
- action audit metadata; and
- bounded errors already approved for terminal display.

The droplet must not retain:

- relay message bodies;
- prompts or model reasoning;
- commands, command output, tool arguments, or tool output;
- secrets or credential material;
- arbitrary local paths; or
- the raw relay journal or job-record files.

Snapshots are held in memory for the first release. Action audit metadata may
be persisted for 30 days with bounded file size and automatic rotation.

## HTTP surface

The first release exposes only:

- `GET /healthz` — process readiness, no relay data;
- `GET /api/v1/snapshot` — latest sanitized state;
- `GET /api/v1/events` — authenticated SSE stream;
- `GET /api/v1/jobs/:jobId` — sanitized detail if present in current state;
- `POST /api/v1/actions/stop-delegate/preview`; and
- `POST /api/v1/actions/stop-delegate/confirm`.

All API responses set `Cache-Control: no-store`. The reverse proxy adds HSTS,
content-type protection, a restrictive Content Security Policy, frame denial,
and referrer suppression. CORS is disabled; the browser UI and API share one
origin.

## Refresh and failure behavior

- Agent heartbeat: every 10 seconds.
- Snapshot refresh while connected: at least every 5 seconds, plus immediate
  refresh after meaningful job or action changes.
- UI marks data stale after 30 seconds without a heartbeat.
- UI marks the local relay host offline after 60 seconds.
- Droplet restart: browsers reconnect; the Mac agent reconnects and sends a full
  snapshot.
- Mac restart: the launch agent reconnects when the user session starts.
- Agent disconnect during a confirmed command: UI reports the result as
  unknown and refreshes state after reconnect; it must not retry a mutation
  automatically.
- Droplet or UI failure never stops, restarts, or reconfigures the relay.

## Implementation phases

### Phase 1: shared read model

1. Extract monitor state projection from `scripts/relay-monitor.js` into a
   transport-neutral module.
2. Preserve terminal output and behavior with regression tests.
3. Add process-liveness and last-activity-age fields without exposing raw
   process details.

### Phase 2: read-only remote monitor

1. Implement the local outbound agent and authenticated WSS handshake.
2. Implement the droplet web service, operator authentication, snapshot API,
   SSE, and responsive UI.
3. Show overview, activity, health, identities, and sanitized job detail.
4. Deploy behind HTTPS and prove disconnect/reconnect behavior.

### Phase 3: exact stuck-delegate control

1. Add preview and short-lived confirmation protocol.
2. Reuse the existing exact-job termination implementation.
3. Add action audit metadata and result reconciliation.
4. Verify that stale or replayed confirmations cannot affect another job.

### Phase 4: optional control-center parity

Individually evaluate restart/repair, completed-activity cleanup, message
cleanup, identity removal, and credential repair. Each action requires its own
data-minimization review, preview binding, tests, and explicit acceptance. They
are not implied by delivery of Phases 1-3.

## Deployment

### Droplet

- Install the pinned Node runtime already approved for the droplet.
- Run `relay-monitor-web` as an unprivileged dedicated service account.
- Use systemd with restart-on-failure, resource limits, and an environment file
  readable only by that account.
- Terminate TLS at the existing reverse proxy.
- Permit inbound 443 only; do not expose the agent listener on a separate
  public port.
- Route the agent upgrade path through the authenticated HTTPS origin.
- Add bounded service logs that exclude request bodies and credentials.

### Mac relay host

- Run `relay-monitor-agent` with `launchd` as the relay-owning user.
- Store its secret in a mode-0600 local file outside the repository.
- Connect only outbound to the droplet's HTTPS endpoint.
- Do not open a firewall port or add a reverse SSH tunnel.
- Keep relay port 9999 loopback-only.

Exact hostnames, addresses, and credentials belong in local deployment notes or
environment configuration, not this repository.

## Testing and acceptance criteria

### Automated

- Existing `npm test` remains green.
- Shared read-model golden tests prove terminal behavior does not drift.
- Protocol schema tests reject unknown message types and extra dangerous fields.
- Authentication tests cover missing, invalid, expired, and replayed agent
  handshakes.
- Browser-session tests cover authentication, CSRF, cache headers, and logout.
- Data-leak tests assert that snapshots and logs contain none of the forbidden
  raw fields.
- Reconnect tests prove full snapshot replacement after sequence gaps.
- Stop tests prove exact-job preview binding, expiry, single use, state-change
  rejection, process-group termination, retained audit record, and preserved
  durable mail.
- Tests use isolated data roots and fake process/service controllers. They never
  stop the production relay or a real delegate.

### Live acceptance

1. Browser loads over HTTPS after authentication on desktop and phone widths.
2. Health, identities, and activity agree with `relay-monitor --once` for the
   same observation time.
3. Starting a synthetic delegate appears within 10 seconds.
4. Disconnecting the Mac agent marks data stale, then offline, without changing
   relay operation.
5. Reconnecting replaces stale state without duplicate jobs.
6. A synthetic stuck delegate can be previewed and stopped; its job becomes
   interrupted and its durable mail remains.
7. A captured or expired confirmation token cannot stop any job.
8. Inspection of droplet state and logs finds no message bodies, prompts,
   reasoning, commands, tool payloads, secrets, or arbitrary local paths.

## Rollout and rollback

Ship Phase 2 read-only first and observe it before enabling any mutation. Gate
Phase 3 behind a disabled-by-default server setting until its live synthetic
test passes.

Rollback is independent on each side:

- stop and disable the droplet web service;
- stop and unload the Mac monitor agent; and
- remove the reverse-proxy route.

No rollback step touches the relay daemon, MCP clients, message history, job
records, or terminal monitor.

## Decisions recorded by this specification

- The browser service runs on the droplet; local authority remains on the Mac.
- Connectivity is outbound WSS from the Mac, not an exposed home-network port.
- The existing relay server remains loopback-only and does not move.
- The first web release is read-only; exact stuck-delegate termination follows
  as a separately gated phase.
- Raw message content and other sensitive model/tool data do not go to the
  droplet in the initial implementation.
- Terminal `relay-monitor` remains supported and shares one operational model
  with the browser UI.
