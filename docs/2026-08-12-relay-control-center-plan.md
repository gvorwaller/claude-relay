# Relay Control Center Plan

## Outcome

The relay remains useful without requiring the operator to remember commands,
identity rules, file locations, or restart procedures. `relay-monitor` becomes
the single human-facing control center. Every available operation is visible,
described in plain language, previewed before it changes data, and reports its
result in the same screen.

## Interaction model

- Arrow keys move through visible actions; Return selects one.
- The activity view remains the default and continues to refresh.
- A persistent action bar exposes **Activity**, **Health**, **Restart/repair**,
  **Clean activity**, and **Clean messages**. No undocumented shortcuts are
  required.
- Selecting an action opens an explanation and preview before anything runs.
- Destructive operations require a second, explicit confirmation. Escape always
  cancels.
- Status and error text stay on screen until acknowledged rather than vanishing
  into a logfile.

## Phase 1: useful control center

1. Refactor the current renderer into a testable monitor model and terminal UI.
2. Add a health screen backed by the same runtime-status assessment as
   `relay-health`.
3. Add restart/repair through the installed launchd service, with a post-action
   health check and a clear warning that active connections briefly reconnect.
4. Add completed-activity cleanup with owner/all scope, exact preview counts,
   confirmation, and guaranteed preservation of spawned/running work.
5. Keep `--once` as a non-interactive diagnostics mode.

## Phase 2: safe message cleanup

1. Add a message-history preview that reports counts by identity and date.
2. Support exact-identity cleanup as well as deliberate global cleanup.
3. Rewrite journals atomically for identity-scoped cleanup; never partially
   edit a journal in place.
4. Require preview-bound confirmation and refresh runtime metrics afterward.

## Phase 3: installation disappears

1. Detect a missing/stopped launchd service and offer **Install/repair relay**.
2. Detect stale MCP clients that do not expose the current tool catalog and
   explain the one required agent restart in the UI.
3. Add a first-run readiness screen covering hooks, identities, connectivity,
   and remote SSH transport without asking the user to know their internals.

## Safety boundaries

- The control center is local-only and refuses mutating actions when stdin is
  not an interactive terminal.
- Restart acts only on the exact `com.claude-relay` launchd label.
- Cleanup never removes active delegate jobs.
- Every cleanup is previewed, scoped, confirmed, and auditable.
- Existing CLI and MCP operations remain automation interfaces, not things the
  human must remember.

## Verification

- Unit tests cover screen models, navigation, cancellation, confirmations, and
  owner-scoped selection.
- Integration tests use isolated data directories and a fake service controller;
  tests never restart the real relay.
- `npm test`, syntax checks, and `git diff --check` remain release gates.
