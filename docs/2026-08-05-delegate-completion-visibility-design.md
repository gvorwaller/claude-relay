# Delegate completion visibility in the owning Codex UI

Status: proposed (design only; implement after the 2026-08-05 adversarial
review findings are fixed)

Related:

- `docs/2026-08-02-wake-on-message-design.md`
- `docs/2026-08-05-codex3-adversarial-review.md`

## Problem

The relay can wake a headless Codex delegate, the delegate can read mail and
act on it, and its replies can be stored durably. None of those facts requires
the already-open Codex UI to show the delegate's outcome.

The 2026-08-05 review exposed the gap:

1. CC6 sent a review request to `CODEX3`.
2. `wake-codex.sh` resumed the owning Codex thread in a detached `codex exec`
   process acting as a delegate.
3. The delegate completed the review and sent one full response to CC6.
4. The open UI did not display a completion message. The result was visible
   only by reading durable relay history later.

That is an auditability failure, even though the work and delivery succeeded.
The human should not need to guess whether a delegate ran, inspect a log, or
ask the foreground model to reconstruct the result from relay history.

## Required outcome

Every delegated wake becomes a tracked job. A job is not considered fully
surfaced until the owning foreground Codex thread displays a completion receipt
to the user.

At minimum, the receipt must say:

- whether the delegated job completed, failed, or was interrupted;
- what it did, in a concise human-readable summary;
- whether it changed files or external state;
- which verification it ran and the result;
- whether it sent relay replies, including each recipient, durable message ID,
  and `delivered` versus `queued` status.

Example:

> Delegate review completed. I sent one response to CC6 (message
> `2de3543c-...`, delivered live). It reported four P1, five P2, and one P3
> findings. No files were changed. Pure unit tests passed 23/23; socket tests
> were unavailable because the sandbox rejected local listeners.

The explicit sentence “I responded to CC6” is part of the contract whenever a
reply was durably recorded. It must come from server evidence, not merely from
the delegate's prose.

## Non-goals

- Do not copy an entire delegate transcript into the foreground thread by
  default. The receipt is a concise summary with links or IDs for inspection.
- Do not represent `delivered: true` as proof that a human or model read the
  reply. It means a live socket accepted it.
- Do not send the receipt as ordinary mail from a delegate back to its own base
  label. That can retrigger wake hooks, and a socket push still does not make
  the UI render an assistant message.
- Do not make UI visibility depend on parsing `logs/wake-codex.log`.
- Do not implement this before the delegate authentication, target-validation,
  identity, wake-debounce, cursor, and registry issues in the adversarial
  review have been resolved. Completion receipts increase the value and the
  sensitivity of delegate identity; they must build on the hardened path.

## Definitions

- **Owner**: the foreground relay identity, such as `CODEX3`.
- **Delegate**: the headless Codex process acting for the owner without owning
  its relay label, such as `CODEX3~wake-23456`.
- **Job**: one server-authorized delegated wake associated with an inbound
  message or cursor.
- **Completion receipt**: the durable, structured outcome of a job.
- **Surfaced**: the receipt appeared in a completed foreground assistant
  message. Merely injecting it into model context is not sufficient.

## Design overview

Use two delivery tiers:

1. **Required baseline: guaranteed display in the next foreground turn.**
   Store a durable receipt, inject pending receipts through a
   `UserPromptSubmit` hook, and use a `Stop` hook to ensure the final assistant
   message actually reports them.
2. **Preferred enhancement: immediate display when the owning UI is
   addressable.** Deliver the completion through the exact Codex App Server
   thread to which the UI is subscribed. Fall back to tier 1 whenever that
   channel is absent or cannot be proven.

Tier 1 is implementable entirely within this repository and is the first
milestone. Tier 2 must not be claimed until an end-to-end test demonstrates
that this specific UI receives and renders the App Server turn events.

## 1. Server-authorized delegate jobs

The notify path creates a job before it launches `wake-codex.sh`.

Minimum job record:

```json
{
  "jobId": "wake_01...",
  "owner": "CODEX3",
  "inboundMessageId": "94817e22-...",
  "requestedAt": "2026-08-05T22:39:07.581Z",
  "status": "spawned",
  "delegateId": null,
  "startedAt": null,
  "completedAt": null,
  "surfacedAt": null,
  "surfacedTurnId": null
}
```

The server mints a single-use delegate capability bound to the job, owner,
inbound message ID, and an expiry. The token is passed to `wake-codex.sh` in a
protected environment variable and consumed during delegate registration.
This job capability should be the same primitive used to fix the unauthenticated
delegate-mode finding; do not create a second parallel trust mechanism.

State transitions:

```text
spawned -> running -> completed -> surfaced
                    -> failed    -> surfaced
                    -> interrupted -> surfaced
```

Invalid transitions fail closed and are logged. A delegate disconnect is not
by itself successful completion.

## 2. Capture an authoritative completion receipt

Replace the final `exec codex exec ...` in `wake-codex.sh` with a small wrapper
that can observe completion while preserving the Codex exit status.

Use supported Codex noninteractive output features:

- `--json` for lifecycle events and terminal status;
- `--output-last-message <private-temp-file>` for the final assistant message;
- optionally `--output-schema <schema-file>` to require a stable final shape.

Suggested model-authored portion:

```json
{
  "status": "completed",
  "summary": "Completed a read-only adversarial review of d4ef638.",
  "changes": "No files changed.",
  "verification": [
    "bash -n and node --check passed",
    "pure unit tests passed 23/23",
    "socket integration unavailable: listen EPERM"
  ]
}
```

Treat this text as a summary, not as authority for external actions. The relay
server already knows which messages the authenticated delegate sent. While the
job is running, attach every successful `message` append from that delegate to
the job:

```json
{
  "to": "CC6",
  "messageId": "2de3543c-...",
  "delivered": true,
  "timestamp": "2026-08-05T22:44:19.195Z"
}
```

The MCP `relay_send` result should also expose the server's message ID and
delivery state rather than discarding the ID from the existing `sent` ack.
This improves both delegate reasoning and human auditability, but the job store
remains authoritative.

On exit, the wrapper submits the captured final output, Codex exit status, and
terminal event to a local authenticated completion endpoint or CLI. The server
merges that with its authoritative outbound-message list and writes the final
receipt atomically.

If the process is killed or times out, a reaper records an `interrupted` or
`failed` receipt. Failures must surface just as successes do.

## 3. Durable receipt storage

Store receipts independently from ordinary relay conversation history so
completion events cannot trigger normal mail hooks or be mistaken for peer
messages.

Requirements:

- atomic append or transactional update;
- owner-scoped visibility;
- seven-day retention by default, consistent with relay history;
- bounded disk use;
- startup recovery for `spawned` or `running` jobs whose process no longer
  exists;
- idempotent completion and surfacing acknowledgements;
- no raw reasoning or secrets in receipts;
- restrictive file permissions because summaries can contain source findings.

A small `delegate-job-store.js` should own the state machine and persistence.
Do not spread whole-file read-modify-write operations across every MCP bridge;
the registry concurrency finding demonstrates why that pattern is unsafe.

## 4. Guaranteed next-turn foreground surfacing

### UserPromptSubmit hook

Add a command hook for foreground Codex sessions. Before the user's prompt is
sent to the model, it queries pending receipts for that session's relay owner.
If any exist, it returns `additionalContext` instructing the model to:

1. lead its response with a concise completion report;
2. state every authoritative outbound relay action, for example “I responded
   to CC6”; and
3. include a hidden or compact receipt marker containing each job ID so the
   `Stop` hook can verify coverage.

The hook must not consume or mark receipts surfaced. Injection is not display.

The hook must detect and exclude headless delegates, otherwise a delegate can
report its own completion inside its hidden turn. Prefer the authenticated job
environment/capability over process-name heuristics.

### Stop hook

The supported Codex `Stop` hook receives `last_assistant_message`. For a
foreground turn with pending injected receipts:

- verify that every injected job ID is represented;
- verify that required facts such as outbound recipients are present;
- if not, return `decision: "block"` with a continuation instruction to report
  the missing receipts;
- if present, atomically mark the receipts `surfaced` with the foreground
  `turn_id` and completion time, then allow the turn to finish.

This is the enforcement boundary. A prompt instruction alone is advisory; the
two-hook handshake makes omission recoverable and testable.

Avoid fragile free-text parsing. The injected context should require a compact
machine marker, for example:

```text
<!-- relay-delegate-receipts: wake_01ABC,wake_01DEF -->
```

The visible prose remains natural. The marker is only a coverage handshake.

### Multiple completions

Batch receipts in chronological order. Show at most five individually; beyond
that, show a count and the highest-severity or failed items first, while the
marker still acknowledges every included job. Never silently drop a receipt.

### No new user prompt

If the UI is idle and no immediate App Server path is available, keep the
receipt pending and issue a content-minimized macOS banner such as:

> CODEX3 delegate completed; result will appear in the next Codex turn.

The banner is notification, not surfacing, and does not transition the job to
`surfaced`.

## 5. Immediate UI delivery through Codex App Server

Codex App Server is the supported interface for clients that need conversation
history and streamed thread/turn/item events. A true immediate assistant bubble
should use the same App Server instance and thread subscription as the owning
UI, rather than starting another detached `codex exec` process and hoping the
UI notices rollout-file changes.

Required discovery before implementation:

1. Determine whether the current Codex UI exposes or can register an
   authenticated local App Server endpoint.
2. Persist the exact App Server `threadId` and endpoint association with the
   relay owner; cwd is not an acceptable identity key.
3. Demonstrate that an external `thread/resume` plus `turn/start` produces
   `item/*` and `turn/completed` events on the UI's existing subscription and
   visibly renders the assistant response.
4. Demonstrate behavior while the foreground thread is busy, idle, closed,
   archived, or on another machine.

If all four pass, the completion service can start a narrowly scoped foreground
turn whose input contains the structured receipt. Mark the receipt surfaced
only after `turn/completed` succeeds. Tier 1 remains the fallback for an
offline or unaddressable UI.

If this UI's owning App Server is not externally addressable, immediate
rendering requires a Codex product capability. Do not emulate it by editing
rollout JSONL, automating UI keystrokes, or racing a second writer against the
same thread.

## 6. Loop prevention and ordering

Completion receipts are control-plane records, not relay messages.

- Creating or completing a receipt must not invoke message notify hooks.
- A foreground receipt-reporting turn must not register as a delegate.
- A relay reply generated during the delegate job is recorded before the job
  can transition to `completed`.
- A completion arriving while an earlier receipt-reporting turn is active
  remains pending for the next turn unless the App Server can safely steer the
  active turn.
- Retries use the same job ID and are idempotent.
- A failed foreground reporting turn leaves receipts pending.

These rules prevent self-mail wake loops and ensure “I responded to CC6” cannot
appear before the server has durably appended that reply.

## 7. Proposed implementation map

After the adversarial-review fixes land:

1. `delegate-job-store.js` (new): job lifecycle, persistence, retention,
   recovery, and owner-scoped pending queries.
2. `notify-hooks.js`: create a job and capability before spawning an exec hook;
   pass job metadata through the runner environment.
3. `scripts/wake-codex.sh`: use the exact persisted Codex session ID, run Codex
   with machine-readable/final-message capture, and submit terminal state.
4. `server.js`: authenticate delegate registration against the job capability,
   associate delegate sends with the job, and expose local completion and
   receipt-query operations.
5. `mcp-server.js`: preserve structured `relay_send` ack fields, expose pending
   receipts if useful for diagnostics, and never let a delegate mark its own
   receipt surfaced.
6. `scripts/codex-delegate-receipts-hook.js` (new): implement
   `UserPromptSubmit` injection and `Stop` verification/acknowledgement.
7. `.codex/config.toml` or documented global configuration: register the two
   command hooks after verifying the repo/global scope appropriate for every
   relay-owned Codex session.
8. Optional App Server completion client, gated behind the discovery tests in
   section 5.

Do not mix the baseline receipt work with App Server integration in one commit.
The baseline should ship and prove durable visibility first.

## 8. Tests

### Unit

- Valid job lifecycle and rejection of invalid transitions.
- Idempotent duplicate completion and duplicate surfacing ack.
- Authenticated delegate capability is single-use, owner-bound,
  message-bound, and expires.
- Authoritative outbound list records recipient, message ID, delivery state,
  and ordering.
- Delegate-authored summary cannot forge or suppress outbound actions.
- Retention, disk cap, crash recovery, and corrupt-tail handling.
- Hook injection does not mark a receipt surfaced.
- Stop hook blocks when a job ID or required outbound recipient is omitted.
- Stop hook acknowledges all receipts only after a conforming assistant
  message.
- Delegate processes are excluded from foreground surfacing hooks.

### Integration

- CC6 sends one request to an idle CODEX3; one delegate runs, replies once,
  exits, and creates one completed pending receipt.
- The next human prompt in CODEX3 produces a visible assistant response that
  says it responded to CC6 and summarizes the work; the receipt then becomes
  surfaced.
- If the first foreground turn fails or is interrupted, the receipt appears on
  the next successful turn.
- A queued reply is described as queued, never delivered.
- A delegate that performs no relay send reports “No relay reply sent.”
- Two delegate completions before the next foreground prompt are both shown in
  order.
- Completion recording does not trigger another delegate wake.
- Restart between delegate completion and the next foreground prompt preserves
  the pending receipt.
- A malicious delegate cannot attach its sends to another owner's job.

### Immediate-UI proof gate

- With the owning UI visibly open, complete a synthetic delegate job and
  observe the completion assistant bubble without human input.
- Record the exact App Server endpoint, thread ID, event sequence, and UI
  version used.
- Confirm `item/agentMessage/*` and `turn/completed` were received on the UI's
  subscribed connection.
- Repeat with the UI closed; verify tier-1 pending delivery on the next turn.
- Do not call immediate delivery supported until this matrix passes.

## 9. Acceptance criteria

The baseline feature is complete only when all of the following are true:

- Every authenticated delegated wake reaches a terminal job state.
- Every terminal job produces a durable completion receipt.
- Every delegate relay send is represented by an authoritative durable message
  ID and delivery state.
- The next successful foreground turn cannot finish without reporting all
  pending receipts.
- A reported receipt says explicitly when and to whom the delegate replied.
- Failed and interrupted jobs surface with the same guarantee as successful
  jobs.
- No completion receipt causes a self-wake loop.
- Receipts survive relay and Codex restarts within retention.
- The full adversarial-review security and concurrency fixes are already green.

Immediate UI delivery is a separate accepted capability only after the App
Server proof gate passes. Until then, product language must say “guaranteed in
the next foreground turn,” not “shown immediately on completion.”

## Rollout order

1. Finish and verify the findings in
   `docs/2026-08-05-codex3-adversarial-review.md`.
2. Add server-authorized job identity and the durable job store.
3. Capture Codex terminal output and authoritative relay-send receipts.
4. Add and test the `UserPromptSubmit`/`Stop` hook handshake.
5. Run the CC6 → CODEX3 end-to-end acceptance scenario.
6. Ship the baseline and observe it for duplicate, missing, or stuck receipts.
7. Investigate App Server immediate rendering as a separate milestone.

