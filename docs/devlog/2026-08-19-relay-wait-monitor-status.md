# 2026-08-19 — Visible relay-wait status

## Change

The relay session inventory now includes bounded foreground-attention state
while a primary identity has an active `relay_wait`. The monitor's **Peers and
sessions** screen renders that state as `waiting for relay mail`, with the
sender filter and locally formatted start time.

The public session metadata deliberately excludes the wait ID and durable
message cursor. The status disappears as soon as the wait is claimed,
cancelled, or its socket disconnects.

## Verification

- Unit coverage verifies the operator-facing topology text.
- Integration coverage verifies active state, bounded fields, and cleanup
  after a message claims the wait.
