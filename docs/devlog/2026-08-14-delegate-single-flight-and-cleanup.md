# Delegate single-flight and cleanup hardening

## Problem

Each relay notification could start another detached Codex delegate for the
same named owner. A live delegate socket prevented some duplicate wakes, but it
did not cover the interval between process spawn and delegate registration, and
the old detached-shell timeout did not reliably terminate descendant Codex and
MCP processes. This left room for overlapping work and stale process trees.

## Implemented behavior

- `DelegateJobStore.activeForOwner(owner)` defines the owner-level
  single-flight gate from canonical `spawned` and `running` jobs.
- An exec notification for a busy owner is deferred. Because the incoming
  message is already in durable relay history, notifications coalesce into one
  trailing wake that rechecks the gate until the current job is terminal.
- Every live Codex peer uses a fresh same-working-directory delegate. The live
  foreground session remains attached and is never resumed concurrently by a
  second writer.
- Detached delegate execution is bounded by the job-session maximum (one hour
  by default). Timeout sends `SIGTERM` and then `SIGKILL` to the whole detached
  process group, covering the shell, wake runner, Codex, and MCP bridge.
- Interrupted jobs revoke their job capability and result secret and remain in
  durable activity history for audit.
- The relay Control Center now exposes **Stop stuck delegate**. It lists only
  canonical active jobs, requires confirmation, asks the local relay server to
  terminate the selected process group, and preserves queued messages.

## Operator workflow

Open `relay-monitor`, choose **Stop stuck delegate**, select the owner/run, and
confirm. If no active jobs exist, the Control Center reports that directly.
Normal operation needs no intervention: mail arriving during active work is
processed by the single successor wake.

## Verification

- Full test suite: 122 passed, 0 failed.
- Added regression coverage for exact-owner active-job selection, coalesced
  successor wakes, detached process-group timeout, Control Center selection,
  and local-admin termination of an active delegate.
- Shell syntax, JavaScript syntax, and `git diff --check` passed.
- The launchd relay service restarted successfully and `relay-health` reported
  all checks passing.
- Post-restart process inspection found no stale wake, delegate-runner, or
  detached `codex exec` processes.
