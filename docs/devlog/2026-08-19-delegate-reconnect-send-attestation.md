# Delegate reconnect and send attestation

## Problem

A headless Codex wake can launch more than one short-lived MCP bridge during a
single turn. The first bridge consumed and deleted the wake's job token while
receiving mail. A later bridge therefore opened a WebSocket but could not
register as the delegate. `relay_send` then waited three seconds and returned a
legacy synthetic success despite receiving no server `sent` acknowledgment.
The message never entered the durable journal, while the delegate's narrative
could still claim it had replied.

## Implemented behavior

- A job credential is reusable only during its bounded wake lease. Every
  registration revalidates exact owner, owner generation, expiry, and spawned
  process ancestry.
- The 0600 token handoff remains available to sequential MCP subprocesses and
  is deleted and revoked as soon as the wake process terminates.
- Only one live MCP bridge may use a job at a time; concurrent reuse is
  rejected.
- A raw WebSocket connection is not considered ready until the relay server
  confirms registration.
- `relay_send` reports success only from an authoritative server `sent` ack.
  Timeout or server rejection produces an explicit unconfirmed-delivery error.
- A delegate that attempted `relay_send` but has no server-attested `outbound`
  record is marked failed even if its process exits zero.
- Delegate result reports include an explicit `replyAttempted` boolean. The
  server cross-checks that claim, plus its sanitized `sending_reply` activity,
  against the outbound record it alone can create. A delegate may still finish
  normally with no outbound message when no reply was warranted.

## Regression coverage

- Capability tests cover sequential reuse, initial-registration expiry,
  session-lease expiry, owner binding, and explicit revocation.
- MCP send integration covers an open, registered transport whose server never
  emits `sent`; the tool returns an error rather than synthetic success.
- End-to-end delegate coverage uses one MCP subprocess to receive, closes it,
  then uses a second subprocess with the same wake credential to send. The
  recipient receives the reply and the job store contains the server-attested
  outbound message.
- Concurrent bridge reuse and attempted-but-unattested completion are covered
  explicitly, including the delegate's `replyAttempted` result claim.
