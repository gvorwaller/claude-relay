# Browser Relay Monitor Phase 4 Admin Parity Specification

Date: 2026-08-29

Task: `td-1554bc`

Status: Proposed

Depends on:

- `docs/2026-08-12-relay-control-center-plan.md`
- `docs/2026-08-26-1336-browser-relay-monitor-spec.md`
- `docs/2026-08-29-relay-monitor-implementation-plan.md`

Target: `https://relay.gaylon.photos`

## Outcome

Add selected administration capabilities from the local `relay-monitor` Control
Center to the authenticated browser monitor without moving relay authority,
secrets, raw data, or arbitrary execution to the droplet.

Phase 4 delivers five independently gated capabilities:

1. restart or repair the exact relay launchd service;
2. remove completed delegate activity;
3. repair one pending owner credential;
4. remove one eligible identity; and
5. remove durable message history.

The browser remains a constrained operator interface. The Mac agent creates
previews, mints confirmation tokens, revalidates local state, invokes existing
local control functions, and reports verified results. The droplet never gains
general relay-admin, shell, filesystem, process, or credential authority.

The existing exact stuck-delegate action remains Phase 3 and is not redesigned
by this specification.

## Design principles

### Local authority remains local

- The relay stays bound to loopback on the Mac.
- Every action is executed by the outbound Mac agent as the relay-owning user.
- The browser and droplet can select only an allowlisted action and a bounded,
  schema-validated target.
- The browser never supplies a PID, signal, executable, command, service label,
  file path, secret, message ID, or record ID.
- Existing `monitor-control.js` and relay operator operations remain the only
  mutation implementations. Phase 4 must not duplicate their rules in the web
  service or browser.

### Preview is authority, not decoration

Every mutation has two separate requests:

1. The browser requests a preview for one allowlisted action and target.
2. The Mac agent reads current local state, rejects an ineligible target, and
   returns a sanitized preview plus a random confirmation token.
3. The browser explicitly confirms using only that token.
4. The agent consumes the token, re-reads state, verifies the preview binding,
   and then invokes the existing exact local operation.

Confirmation tokens:

- are generated only on the Mac from at least 256 bits of randomness;
- expire 60 seconds after preview;
- are single-use and consumed before mutation begins;
- are bound to the action, exact target or scope, previewed state fingerprint,
  and local relay installation;
- cannot be used for another action, identity, owner scope, or record set;
- are never persisted or logged on either host; and
- are invalidated when the agent disconnects or restarts.

### Default deny and independent rollout

Each action has an independent setting on both the web service and Mac agent:

```text
MONITOR_ADMIN_RESTART_ENABLED=0
MONITOR_ADMIN_ACTIVITY_CLEANUP_ENABLED=0
MONITOR_ADMIN_CREDENTIAL_REPAIR_ENABLED=0
MONITOR_ADMIN_IDENTITY_REMOVAL_ENABLED=0
MONITOR_ADMIN_MESSAGE_CLEANUP_ENABLED=0
MONITOR_ADMIN_ACTIVITY_CLEANUP_ALL_ENABLED=0
MONITOR_ADMIN_MESSAGE_CLEANUP_ALL_ENABLED=0
```

An action is available only when:

- its server setting is `1`;
- its agent setting is `1`;
- the agent explicitly advertises the capability after authentication;
- the agent connection and snapshot are fresh;
- the human request passes Cloudflare Access and browser CSRF checks; and
- current local state makes the requested target eligible.

Missing, unknown, mismatched, or stale capability state fails closed. Enabling
one action does not enable any other action. Exact-owner cleanup does not enable
all-owner cleanup.

## Scope

### Included

- A browser Admin section with plain-language action descriptions.
- Sanitized, local-agent-created previews.
- Explicit confirmation dialogs that default to Cancel.
- Short-lived, state-bound confirmation tokens.
- Exact action result reporting and fresh-snapshot reconciliation.
- Bounded audit metadata on the droplet and durable, content-free audit
  metadata on the Mac.
- Per-action feature gates, tests, live acceptance, and rollback.
- Read-only guidance when an action cannot be performed.

### Not included

- Arbitrary relay protocol calls, shell commands, scripts, signals, or service
  names supplied by the browser.
- Raw message bodies, prompts, reasoning, commands, tool data, logs, secrets,
  local paths, PIDs, process trees, message IDs, or record filenames on the
  droplet.
- Editing notify hooks, relay settings, environment files, launchd plists,
  Cloudflare configuration, DNS, or firewall rules.
- Installing or repairing the browser monitor agent from the browser. If that
  agent is offline, no browser mutation is possible.
- Restarting MCP clients, Claude Code, Codex, terminals, parent agents, or the
  Mac.
- Bulk identity removal or bulk credential repair.
- Viewing or exporting message content.
- Role-based multi-operator administration. Phase 4 retains the current single
  operator Access policy; multi-user roles require a separate specification.
- Phase 5 actions inferred from TUI or MCP additions made after this document.

## Architecture

```text
Authenticated browser
  |  explicit HTTPS preview/confirm requests + CSRF
  v
Droplet relay-monitor-web
  |  strict route and JSON schema allowlist
  |  no local relay credentials or mutation implementation
  v
Existing outbound authenticated WSS connection
  |  Cloudflare Service Auth + nonce/HMAC + sequence validation
  v
Mac relay-monitor-agent
  |  capability gate + local preview/token store + mutation mutex
  v
Shared monitor model / monitor-control.js / loopback relay operator API
```

The web service brokers requests but cannot manufacture a valid confirmation.
The Mac agent cannot act without an allowlisted request received on its current
authenticated connection. The relay server continues to enforce local admin
authority and its existing exact-target safety rules.

## Capability negotiation

After the existing agent handshake, the Mac sends an `agent_capabilities`
message before any action request is accepted:

```json
{
  "version": 1,
  "type": "agent_capabilities",
  "sequence": 1,
  "generatedAt": "2026-08-29T23:00:00.000Z",
  "payload": {
    "revision": 1,
    "actions": ["restart_relay", "cleanup_activity"]
  }
}
```

The action list is a strict enum, sorted, unique, and derived only from local
agent settings. The server intersects it with its own settings. The resulting
capabilities are included in authenticated snapshots:

```json
{
  "features": {
    "admin": {
      "restartRelay": true,
      "cleanupActivity": true,
      "cleanupActivityAll": false,
      "repairCredential": false,
      "removeIdentity": false,
      "cleanupMessages": false,
      "cleanupMessagesAll": false
    }
  }
}
```

The server clears negotiated capabilities immediately when the agent
disconnects, becomes stale, changes connection generation, or sends an invalid
sequence. An older agent that does not advertise Phase 4 remains read-only
apart from separately negotiated Phase 3 support.

## Common action protocol

Phase 4 reuses the existing envelope and the following message types:

- `preview_request`
- `preview_result`
- `confirm_request`
- `action_result`
- `protocol_error`

Every payload is validated against the schema for its exact action. Unknown
fields and wrong action/target combinations close the agent connection.

### Preview request

```json
{
  "requestId": "random-request-id",
  "action": "cleanup_activity",
  "target": {
    "scope": "owner",
    "identity": "CODEX1"
  }
}
```

The only target shapes are:

| Action | Allowed preview target |
| --- | --- |
| `restart_relay` | `{}` |
| `cleanup_activity` | `{ "scope": "owner", "identity": "NAME" }` or `{ "scope": "all" }` |
| `repair_owner_credential` | `{ "identity": "NAME" }` |
| `remove_identity` | `{ "identity": "NAME" }` |
| `cleanup_messages` | `{ "scope": "identity", "identity": "NAME" }` or `{ "scope": "all" }` |

Identity values must pass the existing exact client-ID validator. `all` is not
a valid identity. The two `all` targets require their separate all-scope gates.

### Preview result

Successful results contain:

```json
{
  "requestId": "random-request-id",
  "ok": true,
  "preview": {
    "action": "cleanup_activity",
    "summary": {},
    "consequences": [],
    "confirmationToken": "opaque-single-use-token",
    "expiresAt": "2026-08-29T23:01:00.000Z"
  }
}
```

`summary` is action-specific and strictly validated. `consequences` comes from
fixed agent-owned copy, never browser input or raw local error text.

Failed results contain only `requestId`, `ok: false`, and one bounded,
allowlisted error code. Local exceptions, paths, commands, and process details
are not forwarded.

### Confirmation request

The browser confirmation body carries no target:

```json
{
  "requestId": "new-random-request-id",
  "action": "cleanup_activity",
  "confirmationToken": "opaque-single-use-token"
}
```

The agent resolves the action and target entirely from its local token store.
The server may retain the sanitized preview for response correlation, but it
cannot change the target during confirmation.

### Action result

Results contain only bounded action-specific facts, for example:

```json
{
  "requestId": "new-random-request-id",
  "ok": true,
  "result": {
    "action": "cleanup_activity",
    "outcome": "completed",
    "removedCount": 12,
    "activeWorkPreserved": true,
    "completedAt": "2026-08-29T23:00:30.000Z"
  }
}
```

The browser never applies an optimistic state change. It displays the action
result, then waits for a complete refreshed snapshot from the agent.

## Common execution rules

- The agent permits at most one mutating confirmation at a time.
- Preview requests may be concurrent, but any local state change invalidates
  affected tokens.
- If another mutation is in progress, confirmation returns `action_busy`
  without consuming the token.
- Once a token is accepted, it is consumed before the local operation starts.
- A disconnect or timeout after confirmation produces `result_unknown`.
  Neither server nor agent retries automatically.
- On reconnect, the agent sends a full snapshot. The UI reconciles from local
  state and preserves the unknown-result notice until the operator dismisses
  it.
- Preview and confirmation requests are rate-limited per authenticated browser
  session and globally. Initial limits are 10 previews and 5 confirmations per
  minute, with at most one in-flight confirmation.
- Closing, reloading, navigating away, pressing Escape, or selecting Cancel
  never confirms an action.

## Action 1: Restart or repair relay

### Eligibility

The action is available only when the Mac monitor agent is fresh and can prove:

- the target is the exact per-user `com.claude-relay` launchd service;
- the installed plist path is the repository-approved fixed path;
- the delegate job store is readable; and
- no canonical delegate job is `spawned` or `running`.

The browser cannot override the active-work refusal. If active work exists, the
UI lists only its count and advises the operator to wait or use the separate
exact-job stop flow.

The action may remain available when relay runtime health is missing, because
repairing a stopped service is its purpose, provided the agent can still prove
there is no active work in the durable job store.

### Preview

The preview contains only:

- current service state: `running`, `stopped`, `missing_registration`, or
  `unknown`;
- relay health: `healthy`, `needs_attention`, `offline`, or `unknown`;
- active delegate count, which must be zero;
- whether the fixed installed plist is present;
- the consequence that relay clients may briefly reconnect; and
- confirmation expiry.

It does not contain the launchd label, plist path, UID, PID, command, stdout,
or stderr.

The token binds the service-state fingerprint, fixed installation identity,
plist-presence boolean, runtime instance identifier when available, and the
empty active-job set.

### Confirmation and result

The agent revalidates eligibility, then calls the existing `restartRelay`
implementation. That implementation may bootstrap only the fixed installed
plist when the exact service registration is missing.

The result reports:

- `restart_requested` or `repair_requested`;
- whether the relay returned to healthy/running within a bounded 15-second
  observation window; and
- a bounded failure code if it did not.

Failure text from launchctl is retained only in local logs after secret/path
scrubbing. No other service or process may be targeted.

### Browser wording

The confirmation explains:

- messages and activity are not deleted;
- connected relay clients may briefly reconnect;
- the action is refused while delegated work is active; and
- the monitor agent itself is not restarted.

## Action 2: Clean completed activity

### Eligibility and scope

The action operates only on canonical terminal delegate-job records selected by
the existing cleanup model. `spawned` and `running` jobs are never eligible.

Available scopes:

- one exact owner; or
- all owners, only when `MONITOR_ADMIN_ACTIVITY_CLEANUP_ALL_ENABLED=1` on both
  services.

The UI never defaults to all owners.

### Preview

The preview contains only:

- scope label;
- total eligible count;
- counts by terminal status;
- counts by owner, using identities already permitted in the monitor snapshot;
- oldest and newest eligible timestamps, if present;
- `activeWorkPreserved: true`; and
- fixed irreversible-deletion consequences.

The Mac retains the exact record names and the relay-generated cleanup
confirmation locally. Neither is sent to the droplet. The outer Phase 4 token
binds the scope and exact eligible record-set digest.

### Confirmation and result

The agent re-previews locally and rejects any changed record set. It then calls
the existing `operator_purge_delegate_jobs` path using the locally retained
relay confirmation.

The result contains removed count, scope, `activeWorkPreserved: true`, and the
post-action terminal-record count. A fresh snapshot must still show every
previously active job.

## Action 3: Repair owner credential

### Eligibility

Only one exact named identity currently reported by `pendingOwnerLabels` is
eligible. Confirmed identities, transient watcher identities, `all`, unknown
identities, and arbitrary client IDs are rejected.

### Preview

The preview contains only:

- exact identity;
- whether its relay session is live;
- current state `credential_not_confirmed`;
- consequence `live_session_reconnects` or `credential_ready_next_start`;
- confirmation expiry; and
- fixed assurance that messages, activity, and the identity name are kept.

No current or replacement credential, saved-secret location, PID, socket,
session token, or local path leaves the Mac.

The token binds the identity, owner-credential generation, pending state, and
live connection generation when present.

### Confirmation and result

The agent revalidates that the identity is still pending, then calls the
existing `rotate_owner` operator path with force enabled. The relay creates and
stores the replacement credential locally. The agent must never read the
plaintext replacement into a protocol payload or log it.

For a live identity, only its relay bridge is disconnected so the existing
bridge can reconnect and confirm automatically. For an offline identity, the
credential is ready for its next start.

The result is one of:

- `reconnecting_for_confirmation`;
- `ready_for_next_start`; or
- a bounded rejection code.

The UI continues to show pending until a later fresh snapshot proves
acknowledgement. It must not claim success merely because rotation returned.

## Action 4: Remove identity

### Eligibility

Only one exact item returned by the existing removable-owner operation is
eligible. The local relay remains responsible for excluding identities with
active delegated work and live bridges that cannot be stopped safely.

There is no all-identity or multi-select operation.

### Preview

The preview contains only:

- exact identity;
- `credential_confirmed` boolean;
- live/offline state;
- whether a live relay bridge will be stopped;
- bounded last-activity age or timestamp;
- assurance that messages and completed activity are preserved;
- warning that a future session must enroll again; and
- confirmation expiry.

It does not contain a bridge PID, parent PID, process command, credential,
secret path, or message data.

The token binds the identity, credential generation, live connection
generation, safe-stop decision, absence of active jobs, and the existing local
owner-removal preview confirmation.

### Confirmation and result

The agent revalidates the preview and calls the existing exact owner-removal
operation. If live, it stops only the removable relay MCP bridge. It must never
terminate the parent Claude, Codex, terminal, or desktop process.

The operation removes the owner capability and saved local secret. It preserves
durable messages and completed delegate activity.

The result reports:

- exact identity;
- `identity_removed`;
- whether a relay bridge was stopped;
- `messagesPreserved: true`; and
- `completedActivityPreserved: true`.

## Action 5: Clean message history

This is the highest-risk Phase 4 capability and ships last.

### Eligibility and scope

Available scopes:

- messages sent from or to one exact identity; or
- all durable messages, only when
  `MONITOR_ADMIN_MESSAGE_CLEANUP_ALL_ENABLED=1` on both services.

The UI never defaults to all. All-history confirmation additionally requires
the operator to type the fixed local UI phrase `DELETE ALL MESSAGE HISTORY`.
The phrase is a human-error guard only and is not sent to the agent; authority
still comes exclusively from the confirmation token.

### Preview

The preview contains only:

- scope label;
- eligible message count;
- counts by identity;
- counts by UTC date;
- oldest and newest eligible timestamps;
- whether the scope is global;
- fixed warning that the operation changes conversation history for both
  sides and cannot be undone; and
- confirmation expiry.

The preview must not contain bodies, body snippets, subjects, message IDs,
reply relationships, file names, journal offsets, sender-supplied metadata, or
attachment/tool data.

The Mac retains the exact selected-record digest and the relay-generated purge
confirmation locally. The outer token binds the scope and exact record set.

### Confirmation and result

The agent re-previews and rejects any changed record set. It then calls the
existing atomic message purge operation. Journal replacement must remain
atomic; a failure cannot leave a partially rewritten journal.

The result contains only removed count, scope, remaining durable-message count,
and `atomicRewrite: true`. The server and agent never retry automatically.

Global message cleanup remains disabled after exact-identity cleanup ships. It
requires a separate explicit production approval and live acceptance entry.

## HTTP surface

All endpoints require the human Access application, a valid browser session,
same-origin requests, and CSRF. Cloudflare agent service-token credentials are
not accepted as browser authorization.

```text
GET  /api/v1/admin/capabilities

POST /api/v1/actions/restart-relay/preview
POST /api/v1/actions/restart-relay/confirm

POST /api/v1/actions/cleanup-activity/preview
POST /api/v1/actions/cleanup-activity/confirm

POST /api/v1/actions/repair-owner-credential/preview
POST /api/v1/actions/repair-owner-credential/confirm

POST /api/v1/actions/remove-identity/preview
POST /api/v1/actions/remove-identity/confirm

POST /api/v1/actions/cleanup-messages/preview
POST /api/v1/actions/cleanup-messages/confirm
```

Preview request bodies use only the action-specific target defined above.
Confirm request bodies contain only `confirmationToken`. Unknown and extra
fields return 400 without contacting the agent.

All responses use `Cache-Control: no-store`. CORS remains disabled. Requests
with missing capability, stale agent state, wrong audience, missing CSRF,
invalid scope, or excessive rate return a bounded error without local details.

## Browser interaction

- Add an **Admin** section below read-only health and activity.
- Hide disabled capabilities; show unavailable capabilities as disabled only
  when the explanation helps recovery.
- Each action begins with an explanation and target selection.
- The preview dialog shows exact sanitized scope, consequences, and expiry.
- Destructive confirmation buttons use action-specific wording and default to
  disabled until the preview is complete.
- Cancel is the initial keyboard focus. Escape always cancels.
- Global cleanup is visually distinct and never preselected.
- While a confirmation is in flight, all admin controls are disabled.
- Success, rejection, and unknown-result notices remain visible until
  acknowledged.
- The UI does not infer success from connection loss, HTTP timeout, or a local
  action acknowledgement. It waits for `action_result` and a refreshed
  snapshot.
- Desktop and 390-pixel layouts must show the complete scope, consequences,
  Cancel, and confirmation controls without horizontal scrolling.

## Audit and observability

### Mac audit

Append one mode-0600, content-free record per confirmed attempt to a bounded
local journal. Fields are limited to:

- locally generated action ID;
- action enum;
- exact identity or scope label when applicable;
- previewed count and removed count when applicable;
- outcome enum;
- requested, started, and completed timestamps;
- agent connection generation; and
- whether result reconciliation completed.

Do not record confirmation tokens, browser identity, secrets, paths, PIDs,
commands, message IDs, record IDs, bodies, raw errors, or protocol payloads.

### Droplet audit

Keep at most 100 bounded in-memory action records for browser reconciliation:
action enum, sanitized target label, outcome, and timestamps. Access provider
logs remain the source for human authentication. The application does not copy
email addresses into its own audit journal.

Application and Nginx logs record route, status, duration, and request ID only.
They never log request/response bodies or tokens.

## Failure behavior

| Failure | Required behavior |
| --- | --- |
| Agent offline or stale | Disable admin actions; preserve read-only snapshot with stale/offline warning. |
| Capability mismatch | Return disabled; do not send a command. |
| Preview state changed | Reject confirmation and require a new preview. |
| Token expired or replayed | Reject without mutation. |
| Wrong-action token | Reject without mutation. |
| Confirmation disconnect/timeout | Report result unknown; never retry; reconcile after reconnect. |
| Local operation rejected | Return bounded error code; preserve local details only in scrubbed Mac logs. |
| Snapshot refresh fails after success | Show verified action result plus stale-state warning; do not repeat action. |
| Droplet restart | Lose pending previews; agent reconnects with no tokens restored. |
| Mac agent restart | Lose pending previews; no mutation resumes. |
| Browser reload | Lose UI preview state; no confirmation occurs. |
| Audit write failure | Fail closed before mutation unless the action itself is an explicitly documented emergency repair; Phase 4 defines no such exception. |

## Implementation sequence

### Phase 4A: common substrate and restart/repair

1. Extract shared action enums, target validators, preview schemas, and result
   schemas into transport-neutral modules.
2. Add capability negotiation and server/agent feature intersection.
3. Add the local token store, state fingerprints, mutation mutex, bounded
   errors, local audit writer, and unknown-result reconciliation.
4. Add the Admin UI framework and persistent notices.
5. Implement restart/repair with active-work refusal and post-action health
   observation.
6. Deploy with every new gate off; run isolated and maintenance-window live
   acceptance before enabling restart.

### Phase 4B: completed-activity cleanup

1. Add exact-owner preview and cleanup.
2. Prove active work is preserved under state changes and concurrency.
3. Enable exact-owner cleanup after synthetic live acceptance.
4. Evaluate and approve the separate all-owner gate afterward.

### Phase 4C: identity maintenance

1. Add pending-owner credential repair.
2. Prove no credential or saved-secret detail enters protocol, logs, or audit.
3. Add exact eligible-identity removal.
4. Prove live bridge isolation, parent-process preservation, active-job
   exclusion, and preserved messages/activity.
5. Enable each action separately after synthetic identities pass live tests.

### Phase 4D: message cleanup

1. Add exact-identity metadata-only preview and atomic purge.
2. Perform a dedicated privacy and data-minimization review.
3. Prove unrelated messages and all raw content remain local.
4. Enable exact-identity cleanup after synthetic-history acceptance.
5. Keep global cleanup disabled until separately approved.

## Automated verification

### Common security tests

- Unknown actions, target shapes, fields, scopes, and protocol messages fail
  closed.
- Human endpoints reject missing/invalid Access authentication, agent service
  tokens, missing/wrong CSRF, cross-origin requests, and rate-limit excess.
- Server-only or agent-only feature enablement remains disabled.
- Old agents negotiate no Phase 4 capabilities.
- Tokens reject expiry, replay, wrong action, wrong target, connection change,
  agent restart, state change, and cross-installation use.
- Concurrent confirmations execute at most one mutation.
- Disconnect after confirmation produces unknown result and no retry.
- Snapshots, previews, results, audit, and logs pass forbidden-field and
  forbidden-value scans.

### Restart tests

- Only the exact per-user relay launchd label and fixed plist are used.
- Active delegated work or unreadable job state refuses restart.
- Missing registration may bootstrap only the fixed installed plist.
- Healthy, stopped, failed, and post-restart-timeout states reconcile
  correctly.
- No other process, service, client, or agent is restarted.

### Activity cleanup tests

- Exact-owner and separately gated all-owner scopes preview the correct
  terminal records.
- Spawned/running jobs are never previewed or removed.
- Added, removed, or transitioned records invalidate the preview.
- Confirmation removes exactly the previewed records and preserves active
  work.

### Credential repair tests

- Only pending named identities are eligible.
- Confirmed, transient, hostile, unknown, and `all` identities are rejected.
- Live repair disconnects only the bridge and observes later acknowledgement.
- Offline repair remains pending until next start.
- Replacement credentials never enter agent payloads, browser responses,
  audits, logs, snapshots, fixtures, or assertion output.

### Identity removal tests

- Only exact removable identities appear.
- Active delegated work makes an identity ineligible.
- Unsafe live bridges fail closed.
- State or connection-generation changes invalidate confirmation.
- Live removal stops only the bridge, never the parent agent.
- Owner capability and saved secret are removed; messages and completed
  activity remain.

### Message cleanup tests

- Exact-identity scope includes both sent and received messages.
- All scope is independently gated and never implied by exact cleanup.
- Preview exposes only counts and timestamps, never message content or IDs.
- Journal changes invalidate confirmation.
- Atomic rewrite preserves unrelated messages and survives injected write,
  fsync, rename, and interruption failures without partial history.
- Empty previews and repeated confirmations remove nothing.

The complete existing `npm test` suite, shell/Node syntax checks, plist lint,
`npm audit --omit=dev`, and `git diff --check` remain release gates.

## Live acceptance

Each action is deployed with its gates off and accepted independently.

### Common

1. The public browser remains read-only when either gate is off.
2. Enabling one action exposes only that action.
3. Desktop and phone-width previews are complete and usable.
4. Agent stale/offline state disables all administration without affecting the
   relay or TUI.
5. Expired and captured tokens cannot act on any target.
6. Droplet state and logs contain none of the forbidden raw data.

### Restart/repair

1. First exercise restart against an isolated relay instance.
2. In an approved maintenance window, verify production restart only when no
   active jobs exist.
3. Confirm clients reconnect, durable data remains, and health returns.
4. Confirm an active synthetic delegate causes refusal without restart.

### Activity cleanup

1. Create synthetic completed and active jobs for one synthetic owner.
2. Preview exact-owner cleanup and verify only completed records are counted.
3. Confirm cleanup; active work remains.
4. Capture/replay and changed-state confirmations remove nothing.

### Credential repair and identity removal

1. Create a synthetic pending named identity.
2. Repair it without exposing the replacement credential and observe its
   acknowledgement behavior.
3. Make the synthetic identity removable, preview it, and remove it.
4. Verify its messages and completed activity remain and no parent process was
   stopped.

### Message cleanup

1. Create synthetic messages in both directions plus unrelated control
   messages.
2. Preview exact-identity cleanup and compare counts locally.
3. Confirm cleanup and verify unrelated control messages remain byte-for-byte.
4. Verify no body, ID, or journal detail reached the droplet.
5. Do not live-test or enable global cleanup without separate explicit
   approval.

## Rollout and rollback

- Ship Phase 4 code with every new gate off.
- Enable only one capability for its acceptance window.
- Keep exact-scope gates separate from all-scope gates.
- Record the accepted revision, tests, synthetic targets, outcome, and final
  gate state in the deployment plan and task log.
- Disable an action immediately by turning off its server gate; also turn off
  the agent gate at the next launch-agent refresh.
- Rollback never restarts the relay or reverses a completed deletion.
- Disabling Phase 4 leaves Phase 2 monitoring and the separately gated Phase 3
  exact stop capability intact.
- Deleted activity, removed credentials, removed identities, and deleted
  message history are not recoverable unless an independent backup exists.

## Completion criteria

Phase 4 is complete only when:

- every included action uses the shared local control implementation;
- every action and all-scope variant is independently gated;
- all previews and results are strictly data-minimized;
- expiry, replay, cross-action, cross-target, state-change, concurrency, and
  unknown-result behavior is verified;
- destructive operations preserve the explicitly protected data;
- live acceptance is recorded for each enabled exact-scope action;
- global message cleanup remains off unless separately approved; and
- the task receives implementation-independent review before approval.
