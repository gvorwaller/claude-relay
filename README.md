# Claude Relay

Real-time communication between Claude Code instances across multiple machines via WebSocket + MCP.

For the short operator workflow, including the detached-delegate activity
monitor and one-time Codex hook activation, see [QUICKSTART.md](QUICKSTART.md).

## What This Does

Enables Claude Code sessions on different machines to send messages to each other in real-time. Useful for:
- **Context sharing** - Share findings, file contents, or investigation results between sessions
- **Task handoffs** - Start a task on one machine, continue on another
- **Coordination** - Let one Claude Code instance know what another is doing

## Architecture

```
Machine A                              Machine B (Server Host)
┌─────────────────┐                   ┌─────────────────┐
│  Claude Code    │                   │  Claude Code    │
│      ↓          │                   │      ↓          │
│  MCP Server     │                   │  MCP Server     │
│      ↓          │                   │      ↓          │
│  WebSocket  ────┼── SSH Tunnel ─────┼─→ Relay Server  │
│  (localhost)    │   or direct       │   (port 9999)   │
└─────────────────┘                   └─────────────────┘
```

## Components

| Component | Description |
|-----------|-------------|
| `server.js` | WebSocket relay server (runs via launchd) |
| `mcp-server.js` | MCP server spawned by Claude Code instances |
| `sessions/` | Session identity registry for human-readable IDs |

## Installation

```bash
git clone https://github.com/gvorwaller/claude-relay.git
cd claude-relay
npm install
```

## Quick Start

### 1. Start the Relay Server (on one machine)

```bash
node server.js
# [Claude Relay] Ready! Listening on ws://127.0.0.1:9999
```

### 2. Configure Claude Code (on each machine)

Add to your Claude Code MCP configuration (`~/.claude.json`):

```json
{
  "mcpServers": {
    "claude-relay": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/claude-relay/mcp-server.js"],
      "env": {
        "RELAY_URL": "ws://localhost:9999"
      }
    }
  }
}
```

### 3. Connect Remote Machines via SSH Tunnel

The relay intentionally listens only on loopback. Every remote machine uses an
authenticated SSH local-forward; direct plaintext LAN WebSocket access is not
supported:

```bash
# On the remote machine, tunnel to the server host
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:9999:127.0.0.1:9999 server-host &

# For a persistent macOS tunnel, use the included LaunchAgent with a dedicated
# `relay-m4` SSH host alias. It uses macOS's built-in /usr/bin/ssh; launchd
# restarts it after a disconnect.
cp com.claude-relay-tunnel.plist ~/Library/LaunchAgents/
launchctl bootstrap "gui/$(id -u)" \
  ~/Library/LaunchAgents/com.claude-relay-tunnel.plist
```

The remote MCP bridge still uses `RELAY_URL=ws://127.0.0.1:9999`; traffic
between machines is carried inside SSH. Because every supported client can use
SSH, native WSS is intentionally not part of this deployment.

---

## Session Identity System

Assign human-readable IDs to Claude sessions (CC-1, CC-2, CODEX, etc.) for easier coordination.

### Setup Shell Aliases

Add to your `~/.zshrc` or `~/.bashrc`:

```bash
# Claude Relay Session Management
alias claude-session='source ~/claude-relay/sessions/register.sh'
alias claude-sessions='~/claude-relay/sessions/list.sh'
```

### Usage

**Register a session (in terminal before starting Claude Code):**
```bash
claude-session CC-1
# ✓ Registered: CLAUDE_RELAY_SESSION_ID=CC-1
```

**List all registered sessions:**
```bash
claude-sessions
# === Registered Claude Sessions ===
#   CC-1       PID: 12345  Started: 1/12/2026, 3:30:00 PM
#              CWD: /Users/you/project
#   CODEX      PID: 67890  Started: 1/12/2026, 4:15:00 PM
#              CWD: /Users/you/other-project
```

### Session ID Priority

The MCP server determines client ID in this order:
1. `CLAUDE_RELAY_SESSION_ID` - Shell alias sets this
2. `--client-id` command line argument
3. A single registry entry matching `RELAY_CLIENT_ID` plus the current cwd, such as `CODEX3` for base `CODEX`
4. `RELAY_CLIENT_ID` environment variable
5. Auto-generated: `hostname-pid`

### Session Registry

Sessions are tracked in `~/claude-relay/sessions/registry.json` so all AI instances can see each other.

**One view, live-verified.** `claude-sessions` (sessions/status.js) is the single human-facing view: one table, one line per session, with state checked at print time — `PROCESS` (is the OS process actually running) and `RELAY` (does it have a live relay connection). `claude-peers` is the same table filtered to connected rows. Rows whose process is dead and that have no relay connection are pruned from the registry automatically whenever the table is printed, so ghosts clean themselves up. A row showing `alive` + `NO RELAY` means the agent is running but cannot send/receive relay messages (its relay MCP is not running or not connected) — that distinction was previously invisible.

### Registry identity vs live peers

`relay_sessions` reads the registry, while direct message delivery uses the live WebSocket peer list. A session is healthy only when the same ID appears in both places.

The registry key, MCP `CLIENT_ID`, WebSocket `clientId`, and message `from`/`to` ID must be exactly the same. For example, a Codex window registered as `CODEX3` must connect to the relay as `CODEX3`, not `CODEX`. If `RELAY_CLIENT_ID=CODEX` is configured and exactly one `CODEXn` registry entry matches the current cwd, the MCP server uses that exact registry ID. If a numbered registry ID is shadowed by a generic live peer, `relay_sessions` reports an identity warning instead of aliasing or rewriting delivery.

The relay server rejects duplicate live client IDs. Multiple Codex windows should therefore register distinct IDs (`CODEX2`, `CODEX3`, etc.) instead of sharing `CODEX`.

**Wrong identity at startup?** Startup resolution can pick the wrong ID when the spawning app (e.g. Codex) sets a fixed `RELAY_CLIENT_ID` and launches the MCP process from a cwd that matches no registry entry. No restart is needed to fix it: ask the session to call `relay_rename` with the correct ID (e.g. `relay_rename to=CODEX1`). The MCP client re-registers with the relay server under the new ID (the server drops the old identity from its live peer list immediately) and rewrites the local registry entry.

**Pid-anchored labels.** A label belongs to the process that registered it, for
that process's lifetime — the ID you see in `relay_status`/`relay_sessions` is
the ID peers use, and nothing can silently steal it. When a registration claims
an already-held label, the server checks the current holder instead of
guessing:

- same pid re-registering → reseated (normal reconnect)
- holder's pid is dead → the label was orphaned by a crash; the newcomer takes it
- holder's pid is verifiably alive on the relay host → the newcomer is
  **rejected** (`relay_status` shows REJECTED and stays down; `relay_rename` to
  a different ID, or retry after the owner exits)
- holder is remote or reported no pid → legacy newest-wins takeover (the server
  cannot check pids across machines)

**Restarts come home automatically.** A clean exit keeps the label→cwd mapping
in the local registry (marked `ended`) instead of deleting it, and startup
resolution claims a matching registry label whose recorded pid is dead — so
restarting a session in the same directory lands directly back on its old
label, no `relay_rename` needed. Entries whose pid is still alive are skipped
(that label is owned; the new session auto-numbers instead of fighting), and
`relay_rename` away from a wrong identity still deletes the bad mapping.

**Displacement backoff (unverifiable holders only).** When newest-wins does
displace a client, the displaced side does **not** auto-reconnect — that
guarantees an endless takeover ping-pong. It goes quiet; `relay_status` reports
DISPLACED and the remedy (`relay_rename`).

**Delegates (`RELAY_DELEGATE_FOR`).** A wake hook that resumes a headless
session must read and answer mail for a label an interactive session owns. It
registers as a *delegate*: visible as `<label>~wake-<pid>` in the peer list, it
reads with the label's visibility and its sends arrive from the label, but it
never owns the label — so the interactive session is never displaced, and the
delegate's exit changes nothing. Delegate registration is only honored from the
relay host itself, and a live delegate suppresses further exec wake hooks for
its label (it *is* the woken instance). The job store also enforces one active
(`spawned` or `running`) delegate per owner identity. Mail that arrives while
that owner is busy is already durable, so repeated notifications are coalesced
into one trailing wake after the active job becomes terminal instead of
starting overlapping delegate sessions. The flag reaches Codex bridges via a
`codex exec -c mcp_servers.claude-relay.env.RELAY_DELEGATE_FOR=<label>` config
override (Codex gives MCP servers only curated config env — plain shell
exports never arrive); as a fallback, a bridge that detects a `codex exec`
process ancestor self-selects delegate mode, so headless one-offs never seize
a label even without the flag.

### Watching delegated Codex work

Run `npm run monitor` in the relay checkout (or `node scripts/relay-monitor.js`)
for a live terminal view of recent delegate jobs. Optional flags are
`--owner CODEX3`, `--interval 500`, and `--once`. The monitor shows causal job
state, a deliberately coarse current activity, relay replies and whether each
was delivered live or queued. Select **Activity**, choose a run, and press
Return for its audit report: the incoming request, independently observed
reply and delivery facts, the delegate's structured summary/changes/checks,
sanitized activity timeline, and bounded failure information. Press `C` there
to copy the report.

In an interactive terminal it is also the operator control center. Every
available action is listed with its effect: activity, detailed health, a
live peers/session-details view, a confirmed relay restart, and scoped,
previewed cleanup of completed activity. **Stop stuck delegate** lists only
currently active jobs; after confirmation it interrupts the selected job and
terminates its entire detached process group while retaining the audit record
and all queued relay mail.
It can also atomically clean durable message history for one identity or all
identities after a count preview and a second confirmation. Arrow keys plus
Return are sufficient; CLI and MCP operation names remain
automation interfaces rather than required operator knowledge.

The **Repair owner credentials** action handles identities left in the local
migration fallback by older clients. It installs one atomic replacement secret
at a time; a live session reconnects and confirms it automatically, while an
offline session uses it at its next start.

The activity timeline is a strict allowlist projected from `codex exec --json`.
It never stores or renders raw JSON, hidden reasoning, commands, command
output, tool arguments, arbitrary file paths, or secrets. The explicit audit
screen does show the durable incoming/outgoing relay message bodies relevant
to the selected run, plus the delegate's constrained final report. macOS also
shows content-minimized start and completion/failure notifications; set
`RELAY_DISABLE_NOTIFICATIONS=1` to disable those notices.

Detached delegate commands have a one-hour execution ceiling (or the configured
job-session maximum). On timeout the relay sends `SIGTERM` to the detached
process group, follows with `SIGKILL` after a short grace period if necessary,
and records the job as `interrupted`. Group termination covers the wake shell,
runner, Codex process, and MCP bridge so a timed-out job cannot leave stale
grandchildren behind.

For a live wake-path check, use
`npm run test:wake-e2e -- --target CODEX1`. The helper creates a unique
transient sender, waits for an exact-token reply, and then proves possession of
its one-time owner secret to discard that unacknowledged enrollment before it
exits. This keeps synthetic test identities out of Health and `owners.json`.

Relay Control Center also includes **Remove identity**. It lists named
identities with no active delegated work and shows whether their credential was
confirmed, when they were last active, and whether they still have a live relay
bridge. A live identity is removable only when the relay can stop that exact
MCP bridge safely; the parent Claude or Codex process is never terminated. A
second confirmation removes the owner credential and saved local secret.
Durable messages and completed delegate activity are preserved. If that
identity is used again later, it must enroll again.

Completed jobs remain durable until the owning foreground Codex task visibly
reports the server-generated receipt facts. `scripts/relay-receipts-hook.js`
implements the `UserPromptSubmit`/`Stop` handshake. It processes at most five
receipts per turn, binds the batch to the exact Codex session and fact digest,
and never acknowledges facts omitted from the visible response. Install this
hook only through a trusted local Codex hook configuration; delegates are
explicitly excluded from reporting their own receipts.

For this checkout, copy `codex-hooks.json.example` to `~/.codex/hooks.json`
after deployment, then open `/hooks` in Codex CLI and review/trust both exact
command definitions. Codex hashes command hooks and skips new or changed
definitions until they are trusted; do not bypass that review for ordinary
interactive use.

**Background forks don't inherit identity.** Forked or background Claude sessions (`--fork-session` subagents, `--bg-pty-host` daemon resumes, scheduled runs) inherit `CLAUDE_RELAY_SESSION_ID`/`RELAY_CLIENT_ID` from the original session's environment. The MCP client detects that ancestry (or an explicit `RELAY_BACKGROUND_FORK=1`) and registers as `<ID>-bg<pid36>` instead of seizing the live session's identity. An explicit `--client-id` argument still wins — that's a deliberate choice by the spawner.

---

## MCP Tools

Once configured, Claude Code will have these tools:

| Tool | Description |
|------|-------------|
| `relay_send` | Send a message to peer Claude Code instance(s) |
| `relay_receive` | Get recent messages from peers |
| `relay_wait` | Block for the next matching pushed message, with durable catch-up |
| `relay_peers` | List currently connected instances |
| `relay_status` | Check connection health |
| `relay_rename` | Rename this session's live relay identity at runtime — no restart or env vars; the old ID is released immediately |
| `relay_sessions` | List all registered sessions (including offline) |
| `relay_clear_sessions` | Remove all offline sessions from the local registry (online sessions kept; registry backed up first) |
| `relay_clear_history` | Clear the bounded memory cache; the durable journal remains intact |
| `relay_purge_history` | Delete durable history; restricted by `RELAY_ADMIN_CLIENT_IDS` |
| `relay_delegate_jobs` | Preview terminal detached-job records for one identity or all identities; admin-only |
| `relay_purge_delegate_jobs` | Delete the exact previewed terminal-job selection; admin-only and confirmation-token protected; active work is preserved |

Local operator commands are separate from MCP tools:

```bash
relay-health                         # post-restart fail-closed health gate
npm run owner -- rotate CODEX3      # recover/rotate an offline owner label
```

Owner rotation is authenticated by a private loopback admin capability,
refuses a live owner unless `--force` is explicit, revokes derived credentials,
and writes the replacement directly to the private owner-secret directory.

### Example Usage

**Send a message:**
```
Use relay_send to tell CC-2: "Found the bug - it's in auth.js line 42"
```

**Check for messages:**
```
Use relay_receive to see if there are any messages from peers
```

`relay_receive` accepts optional `from`, `to`, and `after` filters. `after` may
be a returned message cursor or an ISO timestamp. Direct-message history is
visible only to its sender and recipient; broadcasts are visible to all peers.

**Coordinate continuously with a peer:**
```
Use the relay-coordinate skill to coordinate with CC2 until it sends RELAY_DONE
```

`relay_wait` accepts an exact optional `from` peer ID, an optional `after`
cursor (message UUID or ISO timestamp), and `timeoutSeconds` from 1 through 300
(default 240). It first requests authorized durable history, then waits on the
existing WebSocket push path without polling the relay server. A returned
message includes its UUID cursor; pass that cursor as `after` on the next call.
Timeout and disconnect results do not advance the cursor.

The portable [`relay-coordinate`](skills/relay-coordinate/SKILL.md) skill loops
after normal timeouts, processes one peer request at a time, replies to the
exact peer, and stops on the exact `RELAY_DONE` token. Coordination remains an
intentionally active agent turn: it never interrupts running work and cannot
wake Claude Code or Codex after the session has returned control to the user.

### Background doorbell for interactive Claude Code sessions

`relay_wait` intentionally holds its MCP tool call open. For an interactive
Claude Code session that should remain usable, start the content-free watcher
as a background Bash task instead:

```bash
node ~/claude-relay/scripts/relay-watch.js --for CC2 --timeout 240
```

When a direct message to `CC2` or a broadcast is durably stored, the helper
prints `new-message` and exits 0. A normal timeout prints `timeout` and exits 0;
connection failures exit 2. Run it with Claude Code's background-task support
so task completion re-enters the agent, then call `relay_receive` to fetch the
authorized content and cursor through the real MCP identity.

The watcher registers under a distinct generated ID and receives only a
doorbell payload (`type`, watched ID, and timestamp). It receives no sender,
content, cursor, or target history privileges. Like the relay itself, this is a
trusted-network/loopback tool and must not be exposed directly to the internet.

### Wake-on-message: hours of idle listening in one background task

For true wake-on-message (design: `docs/2026-08-02-wake-on-message-design.md`),
`relay-watch-loop.sh` re-arms the watcher until real mail arrives, so a single
background Bash call covers up to `--max-minutes` (default 120) of idle
listening and exits exactly once, printing `new-message`:

```bash
~/claude-relay/scripts/relay-watch-loop.sh --for CC2
```

Launch it with `run_in_background: true` before going idle; the harness's
task notification wakes the session, which then runs `relay_receive`. The loop
pins a `--since` cursor at start and passes it to every re-arm — the server
backfills a ping at subscribe time if mail landed in the deaf gap between one
watcher exiting and the next arming, so nothing sits silently queued.

**Fully automatic version (recommended): the Stop hook.** Sessions should not
have to remember to arm anything, so `scripts/relay-stop-hook.sh` is installed
as an async-rewake `Stop` hook in `~/.claude/settings.json`. Every time any
Claude Code session ends a turn, the hook resolves which relay peer that
session is (by process ancestry against the registry — no env vars, no
per-project config), takes a per-label lock, and listens until mail arrives —
then exits code 2, which makes the harness wake the model with instructions to
run `relay_receive`. Sessions without a relay bridge exit instantly; the
listener stands down if its session dies. With this installed, every CC
session is always reachable while idle, automatically.

### Send acks are honest

`relay_send` (and the raw `message` protocol) now acks every send with
`{ type: 'sent', id, to, delivered }`. `delivered: false` means *queued* — the
message is durably stored and replayed when the target next reads. It is not an
error, and the old `Client X not connected` error is gone. A `delivered: true`
ack means the target's socket took the bytes; it does not mean anyone is
paying attention.

### Server-side notify hooks (waking non-Claude harnesses)

When a message is stored, the server consults optional operator-local config
`data/notify.json` (see `notify.json.example`; override path with
`RELAY_NOTIFY_CONFIG`). The shipped default is a single `"*"` wildcard that
works for **any** peer with zero per-peer configuration: the wake script
itself detects what the target is (Codex peers get resumed; Claude Code peers
exit untouched — they wake via their own watcher; unresumable peers fall back
to a banner). Per-target entries remain available for overrides:

- `{ "type": "banner" }` — content-free macOS notification (sender + target
  only) via `osascript`.
- `{ "type": "exec", "command": "...", "debounceSeconds": 300 }` — run a
  command detached with `RELAY_FOR`, `RELAY_FROM`, `RELAY_MESSAGE_ID`,
  `RELAY_DELIVERED` in the environment. This is how a turn-based harness with
  a headless CLI gets woken. For Codex, use `scripts/wake-codex.sh` (see
  `notify.json.example`): it resolves the peer's *exact* session — registry
  pid → parent codex process → the rollout file it holds open, falling back
  to newest-rollout-matching-cwd — never `--last`, which picks the wrong
  session as soon as several Codex instances run concurrently. The resumed
  run's bridge registers as a delegate (see "Delegates" above), so the
  interactive session that owns the label is never displaced.
- `"onlyIfUndelivered": true` — fire only when the target socket was not live
  at store time. A live delegate for the target also suppresses exec entries
  (it *is* the woken instance; double-spawning would fight it).

Exec hooks are additionally serialized by target identity using the durable
delegate job store. If a job for the owner is already `spawned` or `running`,
the hook schedules one trailing check rather than launching another process.
That check keeps deferring while the owner is busy and launches one successor
after the active job ends, allowing it to process all durable mail accumulated
during the earlier run.

Edits to `notify.json` are picked up without a restart. Hook failures are
logged and never affect message handling. The config is deliberately not a
protocol message: only someone with filesystem access to the server host can
install a hook.

**See who's online:**
```
Use relay_peers to list connected instances
```

**View all registered sessions:**
```
Use relay_sessions to see all Claude sessions, online and offline
```

**Clear stale sessions (e.g., after a reboot):**
```
Use relay_clear_sessions to remove all offline sessions from the local registry
```
Online sessions are never removed, and the registry is backed up to
`sessions/backups/` before each clear.

**Clear relay message history:**
```
Use relay_clear_history to clear the in-memory cache while preserving the durable journal
```

To enable durable-history deletion, set a comma-separated admin allowlist in
the relay server environment, for example
`RELAY_ADMIN_CLIENT_IDS=CODEX1,CC1`, then use `relay_purge_history` from one of
those exact live client IDs. Without an allowlist, durable purge is disabled.

**Clear detached delegate-job history:**

Delegate-job records are stored separately under `data/jobs/` and power
`relay-monitor`; clearing relay message history does not remove them. From an
admin identity, preview an exact owner first:

```text
Call relay_delegate_jobs with owner="CODEX1"
```

The preview returns counts and a confirmation token. Pass that exact owner and
token to `relay_purge_delegate_jobs`. Use owner `"all"` only when the preview
shows the intended cross-owner selection. A changed selection invalidates the
token, and spawned/running jobs are never selected or deleted.

---

## Message Retention and Logs

The relay appends every message to `data/messages/YYYY-MM-DD.jsonl` before it
routes the message. Files and their directory are owner-only (`0600`/`0700`).
The journal retains seven UTC days by default and is also capped at 100 MB;
the oldest files are removed first. On startup, the relay reloads a bounded
cache containing at most 500 messages or 10 MB.

Operational events are written as structured JSONL to
`logs/operations-YYYY-MM-DD.jsonl`. These records contain message IDs,
sender/recipient IDs, byte counts, and delivery status, but never message
content. Logs retain seven days, segment at 10 MB, and are capped at 50 MB.
Duplicate-client rejection records are rate-limited to one per client ID per
minute. The LaunchAgent sends stdout to `/dev/null`; stderr remains available
for failures that occur before structured logging initializes.

Defaults can be changed with:

| Variable | Default |
|----------|---------|
| `RELAY_MESSAGE_RETENTION_DAYS` | `7` |
| `RELAY_MESSAGE_MAX_DISK_MB` | `100` |
| `RELAY_CACHE_MAX_MESSAGES` | `500` |
| `RELAY_CACHE_MAX_MB` | `10` |
| `RELAY_LOG_RETENTION_DAYS` | `7` |
| `RELAY_LOG_MAX_TOTAL_MB` | `50` |
| `RELAY_LOG_MAX_FILE_MB` | `10` |
| `RELAY_ADMIN_CLIENT_IDS` | empty; purge disabled |

---

## macOS Auto-Start (LaunchAgent)

### Relay Server (on server host)

```bash
# Copy the LaunchAgent
cp com.claude-relay.plist ~/Library/LaunchAgents/

# Edit the plist to fix paths for your system:
# - Update /usr/local/bin/node to your node path (use `which node`)
# - Update /Users/yourname/claude-relay to your install path

# Load it
launchctl load ~/Library/LaunchAgents/com.claude-relay.plist
```

**Verify it's running:**
```bash
launchctl list | grep claude-relay
# PID  Status  Label
# 1234 0       com.claude-relay
relay-health
```

### SSH Tunnel (on remote machines)

```bash
# Copy the tunnel LaunchAgent on the remote Mac. It uses /usr/bin/ssh, so no
# Homebrew package or Node change is required.
cp com.claude-relay-tunnel.plist ~/Library/LaunchAgents/

# Add a `relay-m4` entry to ~/.ssh/config for the relay-server Mac. The forward
# remains bound to 127.0.0.1 on both machines.

# Load it
launchctl bootstrap "gui/$(id -u)" \
  ~/Library/LaunchAgents/com.claude-relay-tunnel.plist

# Verify the tunnel and remote bridge path
launchctl print "gui/$(id -u)/com.claude-relay-tunnel" | grep 'state ='
nc -z 127.0.0.1 9999
```

---

## Testing

Use the interactive test client:

```bash
# Terminal 1: Start server
node server.js

# Terminal 2: Connect as client A
node test-client.js MACHINE_A

# Terminal 3: Connect as client B
node test-client.js MACHINE_B

# In either client:
send Hello from here!
peers
history
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_PORT` | `9999` | Port for relay server |
| `RELAY_HOST` | `127.0.0.1` | Listener address; production remains loopback-only |
| `CLAUDE_RELAY_SESSION_ID` | (none) | Human-readable session ID |
| `RELAY_URL` | `ws://localhost:9999` | Relay server WebSocket URL |

### Command Line Arguments

```bash
# Server
node server.js [port]
node server.js 8888

# MCP Server
node mcp-server.js --client-id=LAPTOP --relay-url=ws://192.168.1.100:9999
```

---

## File Structure

```
claude-relay/
├── server.js                 # WebSocket relay server
├── mcp-server.js             # MCP protocol server for Claude Code
├── message-store.js          # Seven-day JSONL journal and bounded cache
├── operational-logger.js     # Rotated structured operational logs
├── test-client.js            # Interactive test client
├── package.json              # Node.js dependencies
├── sessions/
│   ├── register.sh           # Shell script to register session ID
│   ├── list.sh               # Shell script to list sessions
│   └── registry.json         # Session registry (auto-generated)
├── logs/
│   ├── operations-*.jsonl    # Rotated structured relay events
│   └── relay-error.log       # Early startup/runtime stderr
├── data/messages/
│   └── YYYY-MM-DD.jsonl      # Owner-only durable message journal
├── com.claude-relay.plist    # macOS LaunchAgent for relay server
└── com.claude-relay-tunnel.plist  # macOS LaunchAgent for SSH tunnel
```

---

## Troubleshooting

**Connection refused:**
- Ensure relay server is running: `lsof -i :9999`
- If using SSH tunnel, verify it's active: `ps aux | grep ssh`

**MCP tools not appearing:**
- Restart Claude Code after adding MCP config
- Check MCP server is connecting: look for "Connected!" in logs

**Messages not arriving:**
- Use `relay_peers` to verify both instances are connected
- Check message history with `relay_receive`

**Orphaned MCP processes:**
- The MCP server includes a parent process watchdog
- If Claude Code exits unexpectedly, MCP servers self-terminate within 10 seconds
- To manually clean up: `pkill -f "claude-relay/mcp-server.js"`

**Session not showing correct ID:**
- Ensure you ran `claude-session CC-1` BEFORE starting Claude Code
- Check with: `echo $CLAUDE_RELAY_SESSION_ID`
- The session ID is inherited from the shell environment

---

## Security Notes

- The relay server has no authentication by default
- Designed for trusted local networks or SSH tunnels
- All traffic over SSH tunnel is encrypted
- Don't expose port 9999 to the internet without adding authentication

---

## License

MIT
