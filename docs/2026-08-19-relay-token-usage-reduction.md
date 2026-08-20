# Relay token-usage reduction

## Goal

Reduce model context consumed by routine relay coordination without changing
human-facing identities, durable delivery, or the running relay's security
model. `CC1` remains `CC1`; a tool profile is independent session metadata.

## Changes

1. **Lean Claude Code profile.** Claude Code bridges advertise only send,
   receive, peers, status, and rename. They do not advertise `relay_wait` or
   operator/admin tools. A hidden cached call fails with instructions to end
   the turn and rely on the content-free Stop hook. Other harnesses keep the
   full profile, and `RELAY_TOOL_PROFILE=full|claude-core` is an explicit
   override for controlled deployments.
2. **Inbound-only ordinary receive.** Unfiltered mailbox reads exclude the
   identity's own outbound direct messages and broadcasts. Explicit filtered
   audit reads keep the existing authorized-history semantics; `replay=true`
   deliberately resets the cursor but remains an inbound mailbox read.
   Cursor placement remains based on durable order before filtering.
3. **Content-free usage telemetry.** The relay aggregates calls, approximate
   JSON result bytes, sent-message counts/bytes, large-result counts, and
   per-tool totals by canonical identity. It records no prompts, message
   bodies, tool arguments, or tool results. Counters reset with the daemon.
4. **Operator warnings.** Peers and sessions shows the profile and usage
   counters. Results over 8 KiB and messages over 4 KiB are flagged. A large
   send recommends a shared path or commit reference in place of copied text.

## Operational boundary

Development and tests occur in an isolated worktree. Nothing in this change
requires renaming a session or replacing its credential. Activation requires
merging the branch, restarting the shared relay daemon once, and reconnecting
the affected MCP bridges so they load the new tool catalog. Until then, the
running relay remains on its existing checkout and behavior.

## Verification

- Message-store tests prove ordinary reads omit the caller's own traffic while
  explicit reads retain the broader authorized view.
- MCP catalog tests prove Claude Code receives the five-tool profile and a
  stale `relay_wait` call fails with Stop-hook guidance.
- A real MCP-to-relay integration test proves `CC1` remains the exact identity,
  reports `claude-core`, and emits usage metrics after a tool response.
- Server and monitor tests prove aggregation, thresholds, and rendering.
