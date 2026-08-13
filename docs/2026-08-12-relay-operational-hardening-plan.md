# Claude Relay Operational Hardening Plan

Date: 2026-08-12

## Decision

All relay clients in this installation can use SSH. The production relay will
therefore use an SSH-only remote transport instead of adding native WSS:

- The server binds only to loopback on its host.
- Remote machines maintain an authenticated SSH local-forward to that host.
- Remote MCP bridges connect to their own `ws://127.0.0.1:9999`; those bytes
  travel between machines only inside SSH.
- Direct LAN WebSocket access is removed. There is no supported remote
  enrollment over plaintext.

This supersedes the WSS-specific implementation in `td-0944f6` while meeting
its security intent through an authenticated local transport. Native WSS is
not planned unless a future client cannot use SSH.

## Guardrails

- Never delete an unreported delegate job to relieve capacity pressure.
- Never expose message text, prompts, reasoning, command arguments/output,
  paths, or secrets in health or monitor output.
- Health output contains only boolean checks, bounded counts, and fixed
  operator guidance.
- Owner rotation is a local administrative action, refuses a live owner by
  default, invalidates derived credentials, and never prints an old secret.
- Tests use observable state and explicit process cleanup. Deadlines are
  failure bounds, not synchronization.
- Existing uncommitted operator documentation is preserved.

## Phase 1: Deterministic delegate tests (`td-48e913`)

1. Replace the fake wake's fixed sleep lifetime with an explicit release file.
2. Register cleanup immediately with `t.after()` so every fake wake is
   released even after assertion failure.
3. Make token acquisition and terminal-job observation poll observable state;
   retain generous deadlines only to fail a stuck test.
4. Remove comments and assertions that make elapsed time part of correctness.
5. Run the two historical failures repeatedly, then run the full suite at
   least three consecutive times while the live relay/monitor are active.

Acceptance evidence:

- No test depends on a fixed fake-wake sleep duration.
- Every spawned fake wake has deterministic teardown.
- Three consecutive full suites pass.

## Phase 2: Health, retention, and visible alerts (`td-da706c`, `td-3a0115`)

1. Add a small durable runtime-status document written atomically by the
   server. It records only fixed health fields, counts, and alerts.
2. Record startup checks for:
   - loopback bind state;
   - delegate ancestry binding enabled/ready;
   - resolved `lsof` executable;
   - message/capability/job store accessibility;
   - notify configuration validity.
3. Add `scripts/relay-health.js` and a `relay-health` shell alias. It reads the
   status, checks daemon freshness/reachability, prints PASS/WARN/FAIL lines,
   and exits nonzero for unavailable fail-closed controls.
4. Extend the hourly retention loop to call:
   - `messageStore.prune()`;
   - `logger.prune()`;
   - `capabilities.pruneUnacknowledged()`;
   - `jobStore.prune()`.
5. Make job pruning return bounded statistics and surface capacity pressure as
   an active runtime alert. Keep all unreported work.
6. Render active fixed-text alerts in `relay-monitor` and `relay-health`.
7. Replace the release-verification log grep in `DEVELOPMENT.md` with the
   health command.

Acceptance evidence:

- One command proves the fail-closed controls after restart.
- Unit tests cover health freshness, failure exits, scheduled pruning, and
  capacity alerts.
- The monitor shows an operator-visible alert without exposing content.

## Phase 3: SSH-only production transport (`td-a259e6`, `td-0944f6`)

1. Add `RELAY_HOST`, defaulting to `127.0.0.1`, and use it for the WebSocket
   listener. Production launchd sets the loopback address explicitly.
2. Retain the existing autossh LaunchAgent as the supported M2 path; update it
   to bind the remote endpoint explicitly to `127.0.0.1` and document the host
   alias as a required machine-local value.
3. Document installation, launchctl bootstrap/kickstart, and verification on
   both machines. The remote bridge continues using
   `ws://127.0.0.1:9999`.
4. Add an integration assertion that the default server is unreachable through
   a non-loopback interface.
5. On deployment, restart the M4 relay, start/restart the M2 tunnel, verify the
   M2 bridge, and confirm that port 9999 is not listening on a LAN address.
6. Close the WSS TD as superseded by the explicitly selected authenticated SSH
   transport only after the live route is verified.

Acceptance evidence:

- The server listens only on loopback.
- Remote traffic is proven to traverse SSH.
- Direct LAN enrollment and message traffic cannot reach the listener.

## Phase 4: Enrollment expiry and owner rotation (`td-6e03aa`)

1. Make pending/unacknowledged enrollment expiry part of the hourly sweep.
2. Permit a newly expired label to enroll again through the trusted local/SSH
   path; test the crash-before-ack recovery case.
3. Add a local administrative rotation command that:
   - validates the label grammar;
   - refuses rotation while the label is live unless `--force` is supplied;
   - rotates atomically through the running server or another concurrency-safe
     control path;
   - revokes outstanding job/result credentials;
   - writes the replacement owner secret to the expected `0600` file;
   - prints only the label, generation, and secret-file path.
4. Add a documented recovery procedure for a missing owner-secret file.
5. Test refusal for live owners, successful offline rotation, invalidation of
   old credentials, file permissions, and interrupted persistence.

Acceptance evidence:

- An unacknowledged enrollment cannot remain stuck indefinitely.
- The operator can deliberately and safely rotate/recover a label.
- Lost-secret recovery is documented and exercised by tests.

## Release sequence

Each phase is independently reviewed and committed. Before production restart:

1. Run `npm test` three times.
2. Review the exact diff and confirm no secret-bearing files are tracked.
3. Push the reviewed commit(s).
4. Restart the loopback relay in a quiet window.
5. Run `relay-health`.
6. Restart/verify the M2 autossh tunnel and bridge.
7. Send an M2-to-M4 and M4-to-M2 relay message and verify durable delivery.
8. Keep `relay-monitor` open long enough to observe one detached delegate.

## TD disposition

- Submit `td-48e913`, `td-da706c`, and `td-3a0115` after phases 1-2 pass.
- Submit `td-a259e6` after the live M2 tunnel is verified.
- Close `td-0944f6` as superseded only after SSH-only enforcement is deployed.
- Submit `td-6e03aa` after the administrative recovery tests and documentation
  pass.
