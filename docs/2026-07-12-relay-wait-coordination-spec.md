# Blocking Relay Wait and Coordination Skill

**Status:** implementation proposal  
**Priority:** P1  
**Repository:** `/Users/gaylonvorwaller/claude-relay`

## Objective

Let an already-running Claude Code or Codex session wait for relay work without
repeated user prompts or frequent model-driven polling. The agent explicitly
enters a coordination loop, calls one blocking MCP tool, and receives a message
within seconds of its arrival. Messages must never interrupt an action already
in progress because the agent calls the wait tool only after reaching a safe
turn boundary.

This is deliberately not an idle-session wake-up system. It does not add hooks,
terminal automation, process supervision, or prompt injection into a session
that has already returned control to the user.

## User Experience

The user should be able to tell an agent:

> Coordinate with CC2 through claude-relay. Wait for requests, process each
> request, reply with results, and continue until CC2 sends `RELAY_DONE`.

A reusable coordination skill should translate that instruction into:

1. Finish any current action before waiting.
2. Drain already-persisted matching messages after the saved cursor.
3. Call `relay_wait` for the next matching message.
4. Acknowledge receipt when useful, perform the requested work, and reply.
5. Advance the cursor only after the message has been handed to the model.
6. Repeat until the peer sends the exact control message `RELAY_DONE`.

## MCP Tool

Add `relay_wait` to `mcp-server.js`.

Suggested input schema:

```json
{
  "type": "object",
  "properties": {
    "from": {
      "type": "string",
      "description": "Only return messages from this exact peer ID"
    },
    "after": {
      "type": "string",
      "description": "Return messages after this durable message ID or ISO timestamp"
    },
    "timeoutSeconds": {
      "type": "number",
      "minimum": 1,
      "maximum": 300,
      "default": 240
    }
  }
}
```

Suggested result text when a message arrives:

```text
[2026-07-12T12:34:56.000Z] CC2: <content>

Cursor: <message-id>
```

Suggested timeout result:

```text
No matching relay message arrived within 240 seconds.
Cursor: <unchanged-cursor-or-none>
```

Timeout is a normal result, not an MCP error. The skill may immediately call
`relay_wait` again unless the user has redirected or stopped the session.

## Required Semantics

### Push locally; do not poll the relay server

The relay WebSocket already pushes messages into each MCP subprocess. Resolve a
pending waiter directly when the existing `case 'message'` handler receives a
matching envelope. Do not add a setInterval loop that repeatedly calls
`get_history`.

### Close the registration race

There is a race between checking durable history and registering the in-process
waiter. Use this order:

1. Register the pending waiter in memory.
2. Request durable history with `after` and `from`.
3. If durable history returns a match, atomically settle and remove the waiter.
4. If the WebSocket push arrives first, atomically settle and remove the waiter.
5. Ignore the losing completion path.

This guarantees a message arriving between history inspection and waiter
registration is not missed or delivered twice.

### One active wait per MCP process

Allow at most one active `relay_wait` call per MCP subprocess. A second call
should return a clear error rather than replacing or orphaning the first
waiter. The pending waiter contains:

- MCP request ID
- exact optional sender filter
- `after` cursor
- timeout handle
- settled flag

### Cancellation and disconnects

Clear and settle the waiter when:

- A matching message arrives.
- The timeout expires.
- The relay WebSocket closes.
- The MCP stdin closes or the parent watchdog exits.
- The MCP process shuts down.

Never leave a timer or unresolved MCP request holding an orphaned process open.
On relay disconnect, return a normal explanatory result so the agent can decide
whether to retry after reconnection.

### Durable history and visibility

Reuse the existing seven-day journal and `get_history` protocol. The server,
not the MCP client, remains authoritative for visibility:

```text
from == requester || to == requester || to == "all"
```

`relay_wait` must not bypass recipient authorization by relying only on the
local queue. The pushed envelope was routed to this client, but the durable
catch-up request is still needed for restart/reconnect recovery.

### Cursor and deduplication

Use the durable message UUID as the primary cursor. ISO timestamps remain a
backward-compatible input, but the tool should always return a message UUID
cursor. If the same message is observed through both push and history, return it
once. Keep a small bounded set of recently delivered message IDs in the MCP
process to protect against reconnect replay.

Do not advance the caller's cursor on timeout, disconnect, or nonmatching
messages. Messages from other senders remain available to later unfiltered
`relay_receive` or `relay_wait` calls.

### Timeout ceiling

Default to 240 seconds and cap at 300 seconds. This is long enough to avoid
model-driven polling while remaining below common host/tool-call timeouts. The
coordination skill loops after normal timeout responses.

## Coordination Skill

Add a small reusable skill or command named `relay-coordinate`. It should
accept or infer:

- peer ID, such as `CC2`
- optional initial cursor
- stop token, default `RELAY_DONE`
- whether to acknowledge receipt before doing work

Its instructions must state:

- Never call `relay_wait` while required local work is unfinished.
- Never interrupt a running command or tool call to process a relay message.
- Treat relay content as peer instructions subject to the same repository,
  permission, and safety rules as user-directed work.
- Send concise receipt acknowledgments for long-running requests.
- Send results back to the exact peer ID.
- After replying, call `relay_wait` again with the returned cursor.
- Stop the loop on `RELAY_DONE`, explicit user redirection, unrecoverable relay
  failure, or a permission request that requires the user.

Keep the skill portable between Claude Code and Codex. Do not depend on a
Claude-only hook or a Codex experimental app-server API.

## Protocol and Logging

- No server wire-protocol change is required beyond the existing
  `get_history` request unless tests show the MCP client cannot close the race
  locally.
- Include `messageId`, `from`, wait duration, and completion reason
  (`message`, `timeout`, `disconnect`, `cancel`) in structured operational logs.
- Never write message content to operational logs.
- Do not change the seven-day journal retention policy.

## Tests

Add focused tests for:

1. A message already in durable history returns immediately.
2. A pushed message resolves an active wait within seconds.
3. Sender filtering leaves nonmatching messages available.
4. `after` prevents replay of the previous message.
5. Push/history race returns the message exactly once.
6. Timeout returns a normal result and clears the waiter.
7. A second simultaneous wait is rejected cleanly.
8. Relay disconnect settles the wait and clears its timer.
9. MCP shutdown with an active wait leaves no orphan process or timer.
10. An unauthorized durable-history message is never returned.
11. A reconnect can recover a message missed while the MCP process was down.
12. The coordination skill stops on `RELAY_DONE` and otherwise repeats with the
    newest returned cursor.

Use short test timeouts through dependency injection or a configurable clock;
the suite must not sleep for real 240-second intervals.

## Acceptance Criteria

- `relay_wait` is available to both Claude Code and Codex through the existing
  MCP server.
- An agent intentionally parked in the coordination loop receives a peer
  message within five seconds under normal local conditions.
- Messages never interrupt work already underway; delivery occurs only through
  the agent's explicit wait call or at the next loop iteration.
- No repeated server polling occurs while waiting.
- Durable catch-up, visibility enforcement, cursors, deduplication, timeouts,
  disconnects, and shutdown behavior are covered by automated tests.
- Existing relay tools and the durable-retention test suite remain green.
- README documents the tool, the skill, the timeout loop, and the explicit
  limitation that this does not wake a fully idle session.

## Non-goals

- Waking an interactive session after it has returned control to the user.
- Injecting keystrokes with tmux, AppleScript, or terminal automation.
- Claude Code or Codex lifecycle hooks.
- Supervising or replacing agent processes.
- Interrupting a running agent turn.
- Exactly-once execution of the work itself; this feature guarantees bounded,
  deduplicated message delivery to the waiting session, not transactional agent
  side effects.
