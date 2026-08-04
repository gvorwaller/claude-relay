# Wake-on-Message: closing the attention gap

Status: proposed (design only, no code yet)
Motivating incident: 2026-08-02 branch-C QA handoff (trips repo)
Related: `docs/2026-07-12-relay-wait-coordination-spec.md` (blocking wait semantics)

## The incident, as a spec

On 2026-08-02, CC5 sent CODEX a QA handoff at 23:59:59Z. The message was stored
durably and CODEX's connection was live, but CODEX is a turn-based agent: it only
reads the relay when its human prompts it or while a turn is mid-flight. Nobody
prompted it. For ~2 hours:

- CC5 could not distinguish "CODEX is mid-run on my handoff" from "CODEX has
  never seen it" — the two states are identical on the wire.
- CC5 burned 14 × 300 s `relay_wait` re-arms waiting for a report that was never
  coming, then wrongly concluded the peer was unavailable.
- The human had to notice, guess the actual state, and manually poke CODEX,
  after which the handoff was picked up intact and QA ran normally.

Delivery was never the problem — the message store, cursors, and history replay
all worked. The problem is **attention**: nothing can wake an idle agent, and
nobody can see that a peer has unread mail. This doc addresses both.

## What already exists (do not rebuild)

| Piece | Where | What it gives us |
|---|---|---|
| Durable store + cursors | `message-store.js` | Reliable async delivery; nothing is lost while a peer is away |
| `delivered` flag | `server.js` `case 'message'` | Server already knows at append time whether the target socket was live |
| Blocking in-turn wait | `relay_wait` in `mcp-server.js`, `relay-waiter.js` | A *live* turn can listen push-based for ≤300 s |
| Content-free watch protocol | `server.js` `case 'watch'` + `notifyWatchers()` | Any socket can subscribe to "a message for X exists" pings, with no content or history visibility |
| Watch CLI | `scripts/relay-watch.js` | A process that exits `new-message` when mail arrives for `--for X` |

The watch layer is the load-bearing discovery of this design review: **the
sensing half of wake-on-message is already built.** What is missing is (1) the
bridge from "watcher fired" to "idle agent takes a turn", (2) human-visible
notification, and (3) read-state so peers can see unread mail instead of
guessing.

## Design

### 1. Read cursors → unread visibility (server change, the core piece)

Add an explicit read acknowledgement to the protocol:

- New client→server message: `{ type: 'ack_read', cursor: <messageId> }`.
  The MCP server sends it automatically whenever `relay_receive` or
  `relay_wait` returns messages to the model — no new tool, no model
  cooperation needed. Server keeps `Map<clientId, { cursor, at }>`, persisted
  to `data/read-state.json` so restarts don't reset it.
- `get_sessions` / `get_peers` responses gain per-peer
  `{ unreadCount, lastReadAt, oldestUnreadAt }`, computed against the store
  (messages addressed to the peer or `all`, after its read cursor).
- `relay_status` and `relay_peers` in `mcp-server.js` render it:
  `CODEX (3 unread, oldest 41 min)`.

This single feature converts the incident's guessing game into a lookup: CC5
runs `relay_peers` and *sees* that CODEX has not read the handoff. The
sender-side rule becomes mechanical — "unread after N minutes → tell the human
to poke the peer" — instead of a 70-minute vigil.

Notes:
- `ack_read` means "returned to the model in a tool result", not "acted on".
  That is the right bar: it exactly separates "hasn't seen it" from
  "has it and is (or should be) working".
- A peer that has never connected has no read state; report `unreadCount`
  against cursor = none (all messages unread) and `lastReadAt: null`.

### 2. Server-side notify hooks (small server change)

When a message is appended for target X (or `all`), after the existing
`notifyWatchers()` call, consult an optional config `data/notify.json`:

```json
{
  "CODEX": [
    { "type": "banner", "titlePrefix": "relay" },
    { "type": "exec", "command": "/Users/gaylonvorwaller/bin/poke-codex.sh", "debounceSeconds": 300 }
  ],
  "*": [ { "type": "banner", "onlyIfUndelivered": true } ]
}
```

- `banner`: macOS Notification Center via `osascript -e 'display notification …'`.
  Content-free (sender ID + count only), consistent with the watch layer's
  privacy stance.
- `exec`: run a command with `RELAY_FOR`, `RELAY_FROM`, `RELAY_MESSAGE_ID` in
  the environment. This is the extension point for harness-specific wake
  mechanisms without the server knowing about any harness.
- `debounceSeconds` per entry so a burst of messages produces one wake.
- `onlyIfUndelivered`: fire only when the append-time `delivered` flag was
  false (peer socket not live) — the "peer is deaf" case that motivated all of
  this. Default false: as the incident showed, a live socket does not imply
  attention, so by default hooks fire regardless.
- Failures are logged via `OperationalLogger` and never affect message
  handling. `exec` runs detached with a timeout; no output is captured into
  the protocol path.

Security: `notify.json` is local operator config on the server host, same trust
level as the launchd plist that already runs the server. No remote client can
install a hook (it is deliberately *not* a protocol message).

### 3. Harness wake recipes (documentation + one tiny wrapper, no server change)

**Claude Code (works today).** A session that wants true wake-on-message runs
the existing watcher as a harness-tracked background process:

```
node ~/claude-relay/scripts/relay-watch.js --for CC5 --timeout 300
```

launched via the Bash tool with `run_in_background: true`, wrapped in a re-arm
loop. When the process exits with `new-message`, the harness fires a
task-notification, which re-invokes the model → the idle session wakes, runs
`relay_receive`, and acts. This is exactly the subagent-waiter pattern used
during the incident, minus the token burn: the watcher is a plain OS process,
not an agent holding `relay_wait` open.

Add `scripts/relay-watch-loop.sh` (the one new artifact in this section):
re-arms `relay-watch.js` until it prints `new-message` (bounded by
`--max-minutes`, default 120), so a single background Bash call covers hours of
idle listening and exits precisely once, when there is real mail.

**Codex app (no known background-task hook).** Fall back to the human path,
made push instead of poll: a `banner` notify hook (§2) on target `CODEX` tells
the operator the moment CODEX has unread mail, and §1 makes the unread state
visible to every other agent so *they* can also say "CODEX hasn't read my
handoff — please poke it". If Codex ever exposes a programmatic trigger, it
slots into an `exec` hook without touching the server again.

### 4. Sender-side honesty (tiny fixes, do first)

- `server.js` `case 'message'`: a direct send to a non-connected peer currently
  answers `{ type: 'error', message: 'Client X not connected' }` even though
  the message **was durably stored** and will be replayed. That error caused
  real confusion during the incident triage. Change to
  `{ type: 'queued', to, unreadCount }` and have `relay_send` render
  "queued for X (offline, N unread)" instead of an error.
- `relay_send` to a connected-but-idle peer should render "sent to X
  (connected; N unread including this)" once §1 lands — a live socket must not
  read as "they'll see it".

## What this deliberately does not do

- **No interim "nudges" mid-run.** A turn-based peer cannot service pushes
  mid-turn; pretending otherwise recreates the confusion. The design wakes
  *idle* agents and informs humans; it does not interrupt busy ones.
- **No content in notifications.** Banners and watcher pings stay content-free,
  preserving the existing watch layer's privacy model.
- **No polling.** Everything here is push off the existing WebSocket events.

## Rollout order

1. §4 queued-not-error fix (smallest, corrects an active lie).
2. §1 read cursors + unread in `relay_status`/`relay_peers` (the core).
3. §3 `relay-watch-loop.sh` + recipe docs.
4. §2 notify hooks (banner first, exec second).

## Test plan

- `message-store` / server integration tests: `ack_read` persistence, unread
  computation against `to` and `all`, restart survival, never-connected peers.
- Waiter regression: `ack_read` emission from `relay_receive`/`relay_wait`
  paths must not change `relay-waiter.js` cursor semantics (existing tests in
  `tests/relay-waiter.test.js` stay green).
- Notify hooks: unit-test debounce and `onlyIfUndelivered` against a fake
  exec/banner runner; integration test that a hook failure leaves message
  handling untouched.
- End-to-end rehearsal of the incident: peer B idle with a watcher loop armed
  → A sends → B wakes and receives within seconds; peer C (no watcher, Codex
  role) → A sends → banner fires and A's `relay_peers` shows C's unread count
  climbing until C reads.
