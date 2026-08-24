# Retire `relay_wait`

Date: 2026-08-24

## Why

Every supported harness now has a durable wake path: Claude uses its Stop hook,
while Codex, Grok, and AGY use server-side wake delegates. Keeping an MCP tool
that held a model turn open encouraged Claude agents to wait instead of ending
their turns and allowing those hooks to resume work.

## Change

- Removed `relay_wait` from the MCP catalog and dispatcher.
- Removed the foreground attention protocol and its server/watcher bookkeeping.
- Kept durable journal reads, watcher backfill, and notify-hook delivery intact.
- Rewrote the relay coordination skill for asynchronous, hook-driven turns.
- Removed wait-specific tests and documentation, and marked the original
  implementation devlog as historical.
- Updated operator and wake prompts to tell agents to end their turns after
  sending a result.

Stale clients that call `relay_wait` now receive the normal unknown-tool or
profile-unavailable response. `relay_receive` remains the way to read durable
mail at the start of a resumed turn.

## Verification

- Focused MCP, rename, monitor, watcher, notify-hook, and skill tests pass.
- The complete `npm test` suite passes.
- JavaScript syntax checks, shell syntax checks, and `git diff --check` pass.
