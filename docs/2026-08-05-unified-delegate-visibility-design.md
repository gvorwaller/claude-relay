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

- `delegate-job-store.js` (new): owns the job state machine
  (`spawned → running → completed | failed | interrupted → surfaced`),
  atomic persistence, seven-day retention, bounded disk, crash recovery for
  jobs whose process died, idempotent transitions. Invalid transitions fail
  closed. Restrictive permissions (receipts can contain source findings).
- **Two related credentials, not one** (CODEX3 sanity-check blocker #1 — the
  original synthesis wrongly merged them). A job capability authorizes
  *delegate* registration, but it cannot fix ordinary owner-label takeover,
  where an attacker registers as a normal bridge quoting a live holder's pid:
  - **Owner/reconnect capability** — long-lived, rotatable, server-issued at
    first registration; required to claim or reseat a base label.
  - **Job capability** — single-use, expiring, bound to (and derived from) the
    owner capability plus the inbound message; consumed at delegate
    registration and bound to the resulting connection.
  Pid is **never** proof in either path (it stays diagnostic only). Tokens are
  stored hashed. Together these fix findings #2 and #3.
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

- A **separate HTTP listener bound to 127.0.0.1** (not the 0.0.0.0 relay
  socket), plus strict local-address enforcement.
- **Host header validation** (anti-DNS-rebinding) and **Origin rejection**;
  no CORS. Applied to ordinary routes, SSE, *and* WebSocket upgrades alike.
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
- Implementation note: serving HTTP+SSE alongside the WebSocket requires
  refactoring the current direct `WebSocketServer` listener into an explicit
  `http.Server` with a validated upgrade path (CODEX3 #9).

- Content, pushed live over SSE:
  - **Peer table**: labels, pid/cwd, online state; delegates rendered
    distinctly with their job (`CODEX3~wake-17260 · job wake_01AB · running
    2m14s`).
  - **Job feed**: every wake as a causal chain — inbound message → hook fired
    (or deferred, with reason) → delegate registered → outbound sends (server-
    recorded, with delivered/queued) → terminal state → surfaced-or-pending.
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
  (injection is NOT display; never marks surfaced; must exclude delegates via
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
wrong credential refused — each asserted on ordinary routes, SSE, *and*
WebSocket upgrade; SSE exhaustion/backpressure and disconnect cleanup;
redaction and allowlist proof that no raw model/tool stream ever crosses the
endpoint; page state derives only from job-store/server state (kill the log
mid-run: the page stays correct and the activity pane degrades gracefully);
SSE reflects job transitions within one second.

## Acceptance criteria

CODEX3's §9 stands as written for the receipt baseline, with `surfaced` read
as `reported` (terminal Stop-verified state) unless the App Server tier lands.
The page adds one: during any delegate run started while the page is open, a
human can answer "what is CODEX3 doing right now, and did it reply yet?"
without touching a CLI. The combined feature is done when both are true and
neither surface has produced a duplicate, missing, or stuck receipt across a
week of real use.

## Review status

CODEX3 sanity check (2026-08-05, on the pre-revision draft): *request changes*
— blockers on capability merging (#1), `surfaced` semantics (#4), page
hardening (#5), raw stream exposure (#6), plus ordering (#7), CC symmetry
scope (#8), and the http.Server refactor (#9). All are folded into this
revision; the hook contract was confirmed against codex-cli 0.146.0 (#3) and
the control-plane loop rules were cleared unchanged (#2). Awaiting re-check.
