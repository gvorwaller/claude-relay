# Claude Code reconnect identity and cursor repair

## Failure

Claude Code's `/mcp reconnect` could spawn the replacement relay bridge from a
background host carrying another session's inherited `CLAUDE_RELAY_SESSION_ID`.
The background-fork defense correctly avoided stealing that inherited label,
but consequently sent foreground traffic from a generated identity such as
`CC2-bg1mgv` instead of the foreground session (`CC1`). A new MCP subprocess
also had no default receive cursor, so an unfiltered `relay_receive` replayed
old visible history.

## Repair

- A Claude replacement bridge must present both its current transcript session
  and Claude's bridge-session token.
- The current transcript's root `session_id`, project directory, live registry
  PID, and that PID's observed Claude session must resolve to exactly one
  foreground identity. Ambiguity fails closed.
- Only the proven predecessor MCP bridge is retired before the replacement
  reclaims the canonical label. Ordinary background work remains derived.
- Unfiltered mailbox reads persist a private cursor per relay identity in
  `sessions/read-cursors.json`; reconnects resume from it automatically.
- Filtered/audit reads never advance the mailbox cursor. `replay=true` is the
  explicit escape hatch for deliberate resynchronization.

## Verification

- Regression: stale `CC2` environment plus a proven CC1 transcript lineage
  sends as `CC1` and retires only the matching predecessor bridge.
- Security regression: same-lineage background work without a bridge-session
  token remains `CC2-bg...` and does not stop the foreground bridge.
- Cursor regression: after an MCP process restart, an unfiltered receive
  returns only mail after the saved cursor.
- Full suite: `npm test`.
