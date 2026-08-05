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
- The notify path creates the job BEFORE spawning `wake-codex.sh` and mints a
  **single-use, owner- and message-bound, expiring delegate capability** tied
  to the job. Delegate registration consumes it. **This same capability is the
  fix for review findings #2 (forgeable pid) and #3 (honor-system
  delegate=true)** — one trust primitive, not parallel mechanisms (CODEX3's
  requirement, CC6 concurs; CC6's batch-2/3 token plan is superseded by this).
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
parsing: the page may *display* the delegate's streamed output as best-effort
diagnostics, but no state or correctness derives from it.

- The relay server serves `http://localhost:9999/` (WebSocket listener
  attaches to the same HTTP server; loopback-only enforcement on every
  request; zero new dependencies).
- Content, pushed live over SSE:
  - **Peer table**: labels, pid/cwd, online state; delegates rendered
    distinctly with their job (`CODEX3~wake-17260 · job wake_01AB · running
    2m14s`).
  - **Job feed**: every wake as a causal chain — inbound message → hook fired
    (or deferred, with reason) → delegate registered → outbound sends (server-
    recorded, with delivered/queued) → terminal state → surfaced-or-pending.
    This is a rendering of job-store rows, so it is exactly as trustworthy as
    the receipts.
  - **Delegate output pane**: live tail of the running delegate's stream, best
    effort, labeled as diagnostics.
  - Recent relay message metadata (from/to/time/state), body preview
    toggleable — operator's own machine, loopback-only.
- CC sessions appear too: armed stop-hook listeners and their wakes, so the
  page covers both sides of the relay, not just Codex.

## Surface 2 (guaranteed): completion receipts in the owning Codex UI

CODEX3's tier 1, adopted unchanged as the enforcement layer:

- `UserPromptSubmit` hook injects pending receipts for the session's owner
  (injection is NOT display; never marks surfaced; must exclude delegates via
  the job capability, not process-name heuristics).
- `Stop` hook verifies the final assistant message covers every injected job
  ID (compact machine marker for the handshake, natural prose for the human);
  blocks with a continuation instruction if not; atomically marks receipts
  `surfaced` with turn ID when covered.
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

## Symmetry note: CC-side receipts

The same job-store pattern applies to Claude Code wakes cheaply: the stop-hook
wake already re-invokes the model with instructions, and the model's turn IS
the foreground surfacing. A CC wake job records the stop-hook firing and the
turn that consumed it; no UserPromptSubmit machinery is needed there. The page
shows both kinds of jobs uniformly.

## What this deliberately does not do

Union of both parents' non-goals: no transcript copying into foreground
threads; `delivered` never presented as "read"; receipts never sent as
ordinary mail to the owner's own label; no UI-visibility dependency on log
parsing; nothing built before the review's security/concurrency findings
(batch 2: label grammar + argv osascript; batch 3: job capability replacing
pid/delegate trust, registry locking) are green.

## Implementation map

1. **Security prerequisites** (review batches 2–3, with the job capability as
   the unified trust primitive): label grammar enforced at register AND
   message targets; osascript via argv; delegate registration requires a job
   capability; registry read-modify-write locking; session ID persisted in
   registry at bridge registration.
2. `delegate-job-store.js` + server job/receipt operations + wake wrapper
   capture (CODEX3 map items 1–5).
3. **Status page** (CC6): HTTP+SSE on the relay port, reading job store +
   live server state. Ships as soon as the job store exists — it makes every
   later milestone observable while it is built.
4. **Receipt hooks** for Codex foreground sessions (CODEX3 map items 6–7),
   after the hook-contract verification.
5. End-to-end acceptance: the CC6 → CODEX3 scenario from CODEX3 §8, plus:
   the page shows the job's full causal chain live during the run.
6. App Server investigation as a separate, gated milestone.

## Tests

CODEX3's §8 test matrix adopted in full (unit + integration + proof gate).
Additions for the page: loopback-only enforcement (non-loopback request
refused); SSE feed reflects job transitions within one second in integration
tests; page rendering derives only from job-store/server state (kill the log
mid-run: page stays correct, output pane degrades gracefully); delegate
output pane content never enters receipts.

## Acceptance criteria

CODEX3's §9 stands as written for the receipt baseline. The page adds one:
during any delegate run started while the page is open, a human can answer
"what is CODEX3 doing right now, and did it reply yet?" without touching a
CLI. The combined feature is done when both are true and neither surface has
produced a duplicate, missing, or stuck receipt across a week of real use.
