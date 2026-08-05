# Unified delegate visibility: jobs, receipts, and a live window

Status: proposed (design only; implement after the 2026-08-05 adversarial
review findings are fixed). Synthesis of:

- CODEX3, `docs/2026-08-05-delegate-completion-visibility-design.md`
  (completion receipts, guaranteed foreground surfacing)
- CC6, status-page proposal (live observability surface, 2026-08-05)

Related: `docs/2026-08-05-codex3-adversarial-review.md`,
`docs/2026-08-02-wake-on-message-design.md`.

## The two problems, named separately

The 2026-08-05 review run exposed both at once:

1. **Accountability** — the owning Codex UI never showed that a delegate ran,
   what it did, or that it replied to CC6. The human had to trust prose or
   read durable history by hand. (CODEX3's problem statement.)
2. **Observability** — while the delegate was working, the only live view was
   `tail -f logs/wake-codex.log` from a CLI. "WTH is happening on the Codex
   side right now" had no answer a human would accept. (Gaylon's requirement.)

Receipts cannot solve observability (they are post-hoc by design); a live page
cannot solve accountability (a glanceable view guarantees nothing). Both are
required, and both want the same missing foundation.

## Shared foundation: the delegate job store

Adopted verbatim from CODEX3's §1–§3 with one explicit extension. This is the
single source of truth both surfaces read.

- `delegate-job-store.js` (new): owns the canonical job state machine —
  `spawned → running → completed | failed | interrupted → reported [→ surfaced]`,
  where **`reported` is terminal for the baseline** (Stop-hook-verified
  inclusion in a completed assistant message) and `surfaced` exists only if a
  real client acknowledgement becomes available via the App Server tier —
  atomic persistence, seven-day retention, bounded disk, crash recovery for
  jobs whose process died, idempotent transitions. Invalid transitions fail
  closed. Restrictive permissions (receipts can contain source findings).
- **Two related credentials, not one** (CODEX3 sanity-check blocker #1 — the
  original synthesis wrongly merged them). A job capability authorizes
  *delegate* registration, but it cannot fix ordinary owner-label takeover,
  where an attacker registers as a normal bridge quoting a live holder's pid:
  - **Owner/reconnect capability** — long-lived, rotatable, generation-
    versioned, revocable; required to claim or reseat a base label. **First
    claim must be enrolled, not first-come** (CODEX3 re-check #2): on an
    unauthenticated 0.0.0.0 protocol, "issued at first registration" lets a
    squatter claim a label and receive its durable authority. Enrollment is
    via an operator secret / explicit admin approval / trusted local channel;
    a rename may only target an unclaimed label under those same rules, and
    an existing owner capability never authorizes claiming an arbitrary new
    label. Credentials rotate on successful rename rather than being copied.
    The client's plaintext secret lives in a per-owner 0600 file, never in
    the shared registry; the server stores only hashes, compared in constant
    time, persisted atomically, surviving restart.
  - **Job capability** — single-use, expiring, bound to (and derived from) the
    owner capability generation plus the inbound message ID, consumed
    atomically and bound to the resulting connection. **Least authority, not
    just authenticated identity** (CODEX3 re-check #3): a job delegate may
    read only its assigned inbound message/job queue — *not* the base label's
    seven-day mailbox — may send only as that job and only to the inbound
    sender (or an explicit allowlist), and is denied admin, clear/purge, and
    session-enumeration operations. The owner secret is never passed to the
    child. Rotating owner authority revokes all outstanding job capabilities.
  Pid is **never** proof in either path (it stays diagnostic only).
  Together these fix findings #2 and #3.
- While a job runs, the server attaches every successful `message` append from
  the authenticated delegate to the job: recipient, durable message ID,
  delivered-vs-queued, timestamp. Receipts assert outbound actions from server
  evidence only, never from delegate prose.
- The wake wrapper captures Codex terminal state via supported non-interactive
  features (`--json`, `--output-last-message`, optionally `--output-schema`)
  and submits it to a local authenticated completion endpoint. A reaper
  records `interrupted`/`failed` for killed or timed-out jobs — failures
  surface with the same guarantee as successes.
- **Extension (review finding #6):** at registration, a bridge that detects a
  codex parent records its exact rollout/session identifier into its registry
  entry (same lsof mechanism `wake-codex.sh` uses today, done once at startup
  when it is unambiguous). `wake-codex.sh` then resumes by persisted session
  ID; the cwd fallback becomes refuse-and-banner on ambiguity instead of
  newest-wins.
- Control-plane rule (CODEX3 §6): job/receipt records are not relay messages.
  Creating, completing, or surfacing them must never fire message notify
  hooks. No self-wake loops by construction.

## Surface 1 (live): the relay status page — answers "what is happening"

CC6's proposal, downgraded from "the mechanism" to "a read-only view over the
job store and server state" — which resolves CODEX3's non-goal about log
parsing: no state or correctness derives from the delegate's stream.

**Security requirements (CODEX3 blockers #5 and #6 — "the operator's own
machine" is not a security boundary; any web page the operator visits can
issue requests to localhost):**

- **Topology (decided, CODEX3 re-check #4 — option A):** the relay WebSocket
  stays exactly as it is on `0.0.0.0:9999`, untouched. The status surface is a
  **separate `http.Server` bound to 127.0.0.1 on its own port**, serving HTML
  and SSE only. There is therefore **no page WebSocket and no upgrade path to
  secure**, and no refactor of the live relay listener (superseding the
  earlier "same port" note and CODEX3 #9's refactor requirement). Smaller
  attack surface, zero coupling to the message path.
- **Host header validation** (anti-DNS-rebinding) and **Origin rejection**;
  no CORS. Applied to page routes and the SSE stream.
- An **unguessable bearer credential**, never in the URL (printed at server
  start / readable from a 0600 local file).
- `Cache-Control: no-store`, CSP, frame denial, `X-Content-Type-Options`.
- SSE: client caps, backpressure, heartbeat, disconnect cleanup, bounded
  replay.
- **No raw `codex exec --json` stream is ever exposed.** It can carry
  reasoning, tool inputs/outputs, commands, paths, and secrets. The pane shows
  an **allowlisted event projection** with redaction, truncation, and bounded
  retention, default-closed. Relay message body previews are default-off
  (omitted in the first version).
- The page process reads the job store and subscribes to server state; it
  never accepts control operations.

- Content, pushed live over SSE:
  - **Peer table**: labels, pid/cwd, online state; delegates rendered
    distinctly with their job (`CODEX3~wake-17260 · job wake_01AB · running
    2m14s`).
  - **Job feed**: every wake as a causal chain — inbound message → hook fired
    (or deferred, with reason) → delegate registered → outbound sends (server-
    recorded, with delivered/queued) → terminal state → reported-or-pending.
    This is a rendering of job-store rows, so it is exactly as trustworthy as
    the receipts.
  - **Delegate activity pane**: the allowlisted, redacted event projection
    described above — never the raw stream.
  - Recent relay message metadata (from/to/time/state); bodies omitted.
- CC sessions appear too: armed stop-hook listeners and their wakes, so the
  page covers both sides of the relay, not just Codex.

## Surface 2 (guaranteed): completion receipts in the owning Codex UI

CODEX3's tier 1, adopted unchanged as the enforcement layer:

- `UserPromptSubmit` hook injects pending receipts for the session's owner
  (injection is NOT display; never marks a receipt reported; must exclude delegates via
  the job capability, not process-name heuristics).
- `Stop` hook verifies the final assistant message covers every injected job
  ID (compact machine marker for the handshake, natural prose for the human);
  blocks with a continuation instruction if not; atomically records the
  terminal transition with turn ID when covered.
- **Terminal state is `reported`, not `surfaced`** (CODEX3 blocker #4): a
  passing Stop hook proves the marker was in a completed assistant message,
  not that any client rendered it — the UI can disconnect after Stop.
  `surfaced` is reserved for a real client acknowledgement, available only if
  the App Server tier lands.
- **Injection snapshot semantics:** receipts reaching terminal state after the
  `UserPromptSubmit` cutoff stay pending for the *following* foreground turn;
  they are never retro-attached to the in-flight turn.
- Verification is over **structured job IDs and server-generated receipt
  facts injected verbatim**, never brittle free-text recipient phrases.
- **Hook composition is a real limit** (CODEX3 #3): another co-installed Stop
  hook returning `continue:false` takes precedence, so blocking cannot be
  promised absolutely unless composition is controlled. Guard
  `stop_hook_active` and permit at most one corrective continuation, so a
  disagreement degrades to "reported late," never an infinite loop.
- Confirmed against the installed **codex-cli 0.146.0**: `UserPromptSubmit`
  context injection, `Stop` input carrying `turn_id` / `stop_hook_active` /
  `last_assistant_message`, and `decision: block` continuation all exist.
  Keep an end-to-end fixture: config scope and co-installed hooks remain
  runtime variables.
- Receipt contract: terminal state, concise summary, files/state changed,
  verification run, and every outbound relay action ("I responded to CC6,
  message `2de3…`, delivered live") — from server evidence.
- Batching, idle-UI banner ("result will appear in the next Codex turn"),
  failed-turn-leaves-pending: all per CODEX3 §4.
- **Verification prerequisite:** confirm the installed Codex version's hook
  contract (`UserPromptSubmit` availability, `Stop` receiving
  `last_assistant_message`, block semantics) before building; the handshake
  design stands regardless, but the wiring must match the real harness.

## Surface 3 (immediate, gated): App Server rendering

CODEX3's tier 2, unchanged: only after the four-point proof gate (addressable
endpoint, persisted threadId association, demonstrated event rendering on the
UI's live subscription, behavior matrix for busy/idle/closed/remote). Until it
passes, product language is "guaranteed next foreground turn," never
"immediate." No rollout-file editing, no keystroke automation, no second
writer racing the thread.

## Symmetry note: CC-side records

The job-store pattern extends to Claude Code wakes, but **scoped to
observability only** until an equivalent handshake exists (CODEX3 #8). A CC
wake re-invokes the model, but that does not *prove* the job's result appeared
in the resulting turn. So: record the stop-hook firing and the consuming turn
ID, show both kinds of jobs uniformly on the page — and do not claim the
receipt guarantee for CC wakes. Promoting them later means recording the
consuming turn ID plus a verified job marker, exactly as the Codex side does.

## What this deliberately does not do

Union of both parents' non-goals: no transcript copying into foreground
threads; `delivered` never presented as "read"; receipts never sent as
ordinary mail to the owner's own label; no UI-visibility dependency on log
parsing; nothing built before the review's security/concurrency findings
(batch 2: label grammar + argv osascript; batch 3: job capability replacing
pid/delegate trust, registry locking) are green.

## Implementation map

Ordering revised per CODEX3 #7: **the page ships after the accountability
milestone**, not before — it widens attack surface and can create false
confidence while the actual guarantee is still absent. It may be *developed*
earlier behind a disabled local flag.

1. **Security prerequisites.** Owner/reconnect capability + derived job
   capability (pid demoted to diagnostic); registry read-modify-write locking
   (finding #9); exact codex session ID persisted in the registry at bridge
   registration, cwd fallback becomes refuse-and-banner (finding #6).
   *(Done already: batch 1 — findings #4/#5/#7/#8/#10; batch 2 — finding #1
   label grammar + argv osascript.)*
2. `delegate-job-store.js` + server job/receipt operations + wake wrapper
   capture with server-attested outbound sends (CODEX3 map items 1–5).
3. **Receipt hooks** for Codex foreground sessions (CODEX3 map items 6–7),
   after the hook-contract fixture passes.
4. **End-to-end accountability acceptance**: the CC6 → CODEX3 scenario from
   CODEX3 §8. This is the milestone that must land before the page ships.
5. **Hardened status page** over the proven store, with the full security
   checklist above.
6. App Server investigation as a separate, gated milestone.

## Tests

CODEX3's §8 test matrix adopted in full (unit + integration + proof gate),
plus for the two credentials: owner capability required to claim/reseat a base
label, pid alone insufficient, job capability single-use/expiring/owner-bound
and rejected if replayed on a second connection.

Page tests (expanded per CODEX3 #9): non-loopback request refused; hostile
`Host` header refused (DNS rebinding); hostile `Origin` refused; missing or
wrong credential refused — each asserted on page routes and the SSE stream
(there is no page WebSocket under the chosen topology); SSE exhaustion/backpressure and disconnect cleanup;
redaction and allowlist proof that no raw model/tool stream ever crosses the
endpoint; page state derives only from job-store/server state (kill the log
mid-run: the page stays correct and the activity pane degrades gracefully);
SSE reflects job transitions within one second.

## Acceptance criteria

CODEX3's §9 stands as written for the receipt baseline, reading its
`surfaced` as this document's `reported` (the terminal Stop-verified state)
unless the App Server tier lands and supplies a real client acknowledgement.
The page adds one: during any delegate run started while the page is open, a
human can answer "what is CODEX3 doing right now, and did it reply yet?"
without touching a CLI. The combined feature is done when both are true and
neither surface has produced a duplicate, missing, or stuck receipt across a
week of real use.

## Review status

Round 1 (2026-08-05): *request changes* — capability merging, `surfaced`
semantics, page hardening, raw stream exposure, ordering, CC symmetry scope.
All folded in. Hook contract confirmed against codex-cli 0.146.0; control-plane
loop rules cleared unchanged.

Round 2 re-check (2026-08-05): *request changes*, "much closer". Its four
design blockers are resolved here: the state machine is now one canonical
chain with `reported` terminal (#1); owner-capability first claim requires
enrollment, never first-come (#2); job capabilities carry least-authority
scope limits, not just authentication (#3); and the listener topology is
decided as option A — relay WebSocket untouched, status page a separate
loopback HTTP+SSE server with no upgrade path (#4).

Its code verdicts on the shipped branch: findings #1 (injection), #7
(cursors), #10 (mode switching) PASS; #4, #5, #8 were PARTIAL and are now
closed by commit e353311 (async spawn-failure retry, no optimistic rename
commit, token-owned locks), plus delegate immutability and nonce-based
delegate IDs. Awaiting round-3 verification of those code changes.
