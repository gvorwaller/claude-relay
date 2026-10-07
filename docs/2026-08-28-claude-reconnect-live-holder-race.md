# Claude reconnect live-holder registration race

## Status

Resolved in `55cf438` (2026-10-06, with td-49c1df): the server's post-probe
check now distinguishes "a different socket claimed the label" (reject) from
"the probed holder disconnected" (finish the claim), as proposed below.
Regression: `tests/pid-identity.test.js`, "a holder that disconnects during
its liveness probe yields the label". The rest of this note is the original
diagnosis.

The reconnect identity resolution itself works: a replacement Claude Code MCP
bridge can prove its transcript lineage, recover the canonical relay identity,
and retire only the matching predecessor bridge. The failure occurs immediately
afterward, when the replacement registers that recovered identity with the live
relay daemon.

`CC2-bg1ufl` is not stale state from this incident. It is a legitimate active
fork and must not be removed as part of this repair.

## Live reproduction

On 2026-08-28, an idle `CC6` identity was used for a scoped production-like
test against the running local relay:

1. Start a real MCP predecessor registered and connected as `CC6`.
2. Start a replacement MCP bridge with:
   - a different inherited relay identity;
   - a Claude bridge-session token;
   - a child transcript whose root session matches the CC6 predecessor; and
   - the same project directory.
3. Initialize the replacement.

Observed result:

- The replacement resolved through transcript lineage to `CC6`.
- It sent `SIGTERM` only to the proven CC6 predecessor.
- The predecessor exited and its relay socket began closing.
- The replacement connected to the relay before the daemon had processed that
  socket close.
- The daemon began its existing live-holder probe against the old socket.
- While that probe was in flight, the old socket disappeared.
- The daemon returned `register_rejected` with `"CC6" changed hands while your
  claim was being checked; retry.`
- `mcp-server.js` treated every ordinary `register_rejected` as permanent,
  closed its socket, and suspended reconnect.
- The CC6 registry entry remained ended under the predecessor PID; the
  replacement stayed alive briefly but owned no relay identity.

The existing Claude reconnect regression does not catch this. Its predecessor
process is intentionally blocked on MCP stdin and is not connected to the
relay, so there is no overlapping live socket to close.

## Root cause

After awaiting `probeHolder(existingClient)`, `server.js` correctly re-reads
the identity map. It currently treats every value other than the original
socket as a changed-hands rejection:

```js
if (clients.get(requestedClientId) !== existingClient) {
  // reject: changed hands; retry
}
```

That condition conflates two materially different states:

1. A different live socket claimed the identity while the probe was pending.
2. The proven predecessor disconnected, leaving the identity unclaimed.

State 1 must remain a rejection. State 2 is the expected reconnect handoff and
should allow the already-authorized claimant to finish registration.

## Proposed fix

Change the server's post-probe check to distinguish a new holder from no
holder:

```js
const currentHolder = clients.get(requestedClientId);

if (currentHolder && currentHolder !== existingClient) {
  // A different socket really claimed the identity. Reject safely.
  rejectChangedHands();
  return;
}

if (!currentHolder) {
  // The predecessor disconnected during the probe. The label is now free;
  // continue directly to the existing registration commit below.
}
```

If `currentHolder === existingClient`, preserve the current behavior:

- a responsive holder rejects the claimant;
- an unresponsive holder is displaced and reclaimed.

There is no `await` between the final map check and `clients.set()`, so Node's
event loop makes the final claim atomic with respect to other socket handlers.
All existing owner-capability, transcript-lineage, same-project, and PID
verification remains unchanged.

Do not broadly retry every `register_rejected` response in the MCP client.
Doing so would revive identity takeover loops for genuinely occupied labels.
If a client-side defense is added, the server must first provide a structured,
machine-readable transient reason such as
`reasonCode: "holder_disconnected_during_probe"`; only that reason may retry,
and retries must be bounded.

## Required regression coverage

1. Connected holder disconnects while its liveness probe is pending: the
   claimant registers successfully under the same identity.
2. A different socket claims the identity while the probe is pending: the
   original claimant is rejected.
3. The original holder answers the probe: the claimant is rejected and the
   holder remains connected.
4. End-to-end Claude reconnect with a predecessor that is actually connected
   to the relay: the replacement retires it and registers canonically.
5. Two sequential reconnects with an unfiltered mailbox read between them:
   the second bridge resumes from the saved identity cursor and does not replay
   the pre-reconnect marker.
6. Re-run the live CC6 probe only when relay activity is quiet.

## Verification already completed

- The repository's full automated suite passed 141/141 before the live probe.
- Transcript-lineage matching selected `CC6`, not the inherited identity.
- Only the proven predecessor was terminated.
- The live-socket overlap race reproduced deterministically with a connected
  CC6 predecessor.
- No application source was changed during diagnosis.

## Operational cleanup

The test left `CC6` offline with no saved cursor and no durable probe messages.
Temporary transcript fixtures and replacement processes were removed. The
unrelated active `CC2-bg1ufl` fork was not touched.
