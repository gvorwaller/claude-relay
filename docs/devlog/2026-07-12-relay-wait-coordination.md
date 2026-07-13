# 2026-07-12 - Blocking Relay Wait and Agent Coordination

## 16:53 EDT - `relay_wait`, `relay-coordinate`, and Global Claude MCP Setup

### Summary

Implemented `td-836e6d`, adding a blocking `relay_wait` MCP tool and a reusable
`relay-coordinate` skill. Two active Claude Code or Codex sessions can now
exchange work, review, corrections, and verification without the user manually
carrying each message between them. The agents remain in an intentional
coordination loop until the defined work is complete; the skill uses the exact
internal stop token `RELAY_DONE` so the user only needs to define what “done”
means.

The existing `claude-relay` MCP server was also moved from Claude Code’s
repository-specific configurations to one user-scoped definition. It points
directly at this checkout’s `mcp-server.js`, so future MCP code changes require
restarting agent sessions, not copying MCP configuration into every repo.

Committed and pushed as `d6f84a2` (`Add blocking relay coordination workflow`)
on `main`. The task is approved and closed.

### User Workflow

The user starts both agent sessions and gives each a coordination assignment,
including the peer ID and a human-level completion condition. For example:

```text
Work this out with CODEX2 through claude-relay. Continue exchanging work and
review until the implementation passes both test suites and all review findings
are resolved. Then report the result to me.
```

The skill handles the protocol details:

1. Send or receive the next peer message.
2. Call `relay_wait` with the exact peer and latest cursor.
3. Process the request under the same repository, permission, and safety rules
   as user-directed work.
4. Reply to the exact peer and wait again.
5. When the defined completion condition is satisfied, send/recognize the exact
   `RELAY_DONE` control message and leave the loop.

Both sessions must remain actively inside their coordination loops. This does
not wake an agent after it has returned control to the user, interrupt a running
tool call, inject terminal input, or supervise agent processes.

### MCP Implementation

Added `relay_wait` to the existing MCP server rather than creating another MCP
server. Inputs are:

- optional exact `from` peer ID;
- optional `after` UUID or ISO timestamp cursor;
- `timeoutSeconds`, default 240 and capped at 300.

`relay-waiter.js` owns the testable wait state machine:

- only one active waiter per MCP subprocess;
- the waiter is registered before durable history is requested, closing the
  push-versus-history registration race;
- the first matching push or authorized history result settles the waiter;
- losing race completions are consumed without returning the message twice;
- recently delivered UUIDs are retained in a bounded deduplication set;
- sender filters and cursors are applied without consuming nonmatching work;
- timeout and disconnect are normal results and never advance the cursor;
- disconnect, stdin close, watchdog exit, `SIGINT`, and `SIGTERM` clear active
  timers and settle or cancel the waiter;
- reconnect cleanup removes stale history-request tombstones so they cannot
  consume a later response.

No relay-server polling loop was added. Live delivery uses the existing
WebSocket push handler. Durable catch-up still uses `get_history`, leaving the
server’s requester visibility rule authoritative:

```text
from == requester || to == requester || to == "all"
```

Wait completion logs contain only operational metadata (`messageId`, `from`,
wait duration, and completion reason). Message content is not written to those
logs, and the existing seven-day journal policy was not changed.

### Coordination Skill

Added the portable source skill at:

```text
skills/relay-coordinate/SKILL.md
```

Installed identical global copies for the two clients:

```text
~/.codex/skills/relay-coordinate/SKILL.md
~/.claude/skills/relay-coordinate/SKILL.md
```

The skill tells agents to finish current work before waiting, never interrupt a
running command, acknowledge long-running requests when useful, return results
to the exact peer ID, reuse the newest UUID cursor, loop after normal timeouts,
and stop on `RELAY_DONE`, user redirection, unrecoverable relay failure, or a
permission decision requiring the user.

The global skill files are copies, not links. Future skill-text changes must be
copied to both client directories again. MCP implementation changes do not have
that requirement because both clients execute `mcp-server.js` directly from
this checkout.

### Claude Code Global MCP Migration

Created one user-scoped Claude Code MCP definition in `~/.claude.json`:

```text
Scope: User config (available in all projects)
Command: node /Users/gaylonvorwaller/claude-relay/mcp-server.js
RELAY_URL: ws://localhost:9999
Status at verification: Connected
```

Removed the old repository-specific relay configurations:

- deleted this repository’s now-empty tracked `.mcp.json`;
- removed `claude-relay` from Listsurf’s `.mcp.json` while preserving its
  unrelated `xcodebuildmcp` entry;
- removed nine legacy project/local relay registrations from Claude’s global
  project registry, including one stale worktree record.

Post-migration verification found zero project entries containing a
`claude-relay` MCP definition. Codex already used the shared global definition
in `~/.codex/config.toml`, so its MCP scope did not need migration.

### Tests and Verification

Added focused deterministic tests for:

- immediate durable-history delivery;
- pushed delivery;
- sender filtering;
- UUID and ISO cursor behavior;
- push/history race settlement and deduplication;
- timeout and cursor preservation;
- simultaneous-wait rejection;
- disconnect and cancellation cleanup;
- metadata-only logging;
- the coordination skill’s repeat and `RELAY_DONE` behavior.

Added an end-to-end test that starts a real relay server and MCP subprocess,
then verifies offline durable catch-up, rejection of an overlapping wait, and
live pushed settlement through JSON-RPC/WebSocket.

Final verification:

```text
npm test: 17 passed, 0 failed
git diff --check: clean
HEAD: d6f84a29265b29bd1b4dbfaa5426597649b89628
origin/main: d6f84a29265b29bd1b4dbfaa5426597649b89628
td-836e6d: closed and approved
```

The integration tests require permission to bind temporary localhost WebSocket
ports. A sandboxed run failed at the server-start assertions; the same suite
run with local-listener permission passed all 17 tests.

### Files Changed in `d6f84a2`

- deleted `.mcp.json`
- updated `README.md`
- updated `mcp-server.js`
- added `relay-waiter.js`
- added `skills/relay-coordinate/SKILL.md`
- added `tests/relay-waiter.test.js`
- added `tests/mcp-wait-integration.test.js`
- added `docs/2026-07-12-relay-wait-coordination-spec.md`

## 19:02 EDT - Content-Free Background Watcher Doorbell

### Motivation

The blocking MCP tool is correct for walk-away coordination, but an MCP tool
call holds the caller’s turn open. That makes `relay_wait` unsuitable when a
Claude Code session should remain interactive while waiting for peer work.
Claude Code background Bash tasks provide a useful wake mechanism: completion
of a background command re-enters the agent without monopolizing its foreground
turn.

CC2 and CODEX3 reviewed two alternatives over the relay itself:

1. An HTTP long-poll endpoint that accepted a target client ID and returned
   messages was rejected. The current WebSocket protocol has no authentication,
   and an HTTP caller claiming a live client identity would bypass the existing
   duplicate-ID guard and weaken history authorization.
2. A content-free watcher “doorbell” was accepted. It reveals only that a
   watched identity received mail, while the real MCP session remains solely
   responsible for fetching authorized content.

### Implementation

Added the registered WebSocket request:

```json
{"type":"watch","for":"CC2"}
```

The watcher must use its own distinct connection identity. The server stores
subscriptions by watched client ID. After it durably records either a direct
message to that ID or a broadcast, it pushes only:

```json
{"type":"new_message","for":"CC2","at":"2026-07-12T22:58:54.701Z"}
```

No sender, content, message UUID, or cursor is included. Watchers receive no
delegated history visibility. Subscriptions are removed when the watcher
disconnects, and a connection can replace its own watched target without
leaving a stale subscription.

Added `scripts/relay-watch.js`, which:

- registers with a generated identity such as `CC2-watch-<pid>-<random>`;
- subscribes to one exact target;
- prints `new-message` and exits 0 on a doorbell;
- prints `timeout` and exits 0 after a normal bounded wait;
- prints an error and exits 2 when the relay is unavailable;
- defaults to `RELAY_URL` or `ws://localhost:9999` and caps waits at 300 seconds.

Claude Code background-task usage:

```bash
node ~/claude-relay/scripts/relay-watch.js --for CC2 --timeout 240
```

When the background task completes with `new-message`, the agent calls
`relay_receive` through its real MCP identity, processes and replies to the
message, and starts another background watcher if coordination should continue.

### Security Boundary

This remains a trusted-network/loopback tool. An unauthenticated peer can learn
only that a named client has new mail—a small metadata expansion over the
existing unauthenticated relay, where peers can already connect and receive
broadcasts. The watcher cannot impersonate the target, read direct-message
history, or obtain message contents. Port 9999 must still not be exposed to the
public internet.

### Verification and Rollout

Expanded the server integration test to:

- subscribe a distinct watcher to `B`;
- deliver a private message to `B`;
- assert the doorbell contains exactly `type`, `for`, and `at`;
- spawn the real helper CLI and verify it exits 0 with `new-message`;
- confirm an outsider can read its own direct message but not `B`’s private
  message.

Final result:

```text
npm test: 17 passed, 0 failed
td-c87994: closed and approved
```

Restarted `com.claude-relay` with `launchctl kickstart -k`; CODEX3 reconnected
successfully and reported CC2 online. Sent CC2 the helper usage and completion
result over the relay, then closed the coordination exchange with `RELAY_DONE`.

### Files Added or Updated

- updated `server.js`
- added `scripts/relay-watch.js`
- updated `tests/server-integration.test.js`
- updated `README.md`
