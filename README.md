# Claude Relay

Real-time communication between Claude Code instances across multiple machines via WebSocket + MCP.

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
# [Claude Relay] Ready! Listening on ws://localhost:9999
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

If machines aren't on the same network, use SSH port forwarding:

```bash
# On the remote machine, tunnel to the server host
ssh -N -L 9999:localhost:9999 server-host &

# Or use autossh for auto-reconnecting
autossh -M 0 -N -L 9999:localhost:9999 server-host &
```

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

### Registry identity vs live peers

`relay_sessions` reads the registry, while direct message delivery uses the live WebSocket peer list. A session is healthy only when the same ID appears in both places.

The registry key, MCP `CLIENT_ID`, WebSocket `clientId`, and message `from`/`to` ID must be exactly the same. For example, a Codex window registered as `CODEX3` must connect to the relay as `CODEX3`, not `CODEX`. If `RELAY_CLIENT_ID=CODEX` is configured and exactly one `CODEXn` registry entry matches the current cwd, the MCP server uses that exact registry ID. If a numbered registry ID is shadowed by a generic live peer, `relay_sessions` reports an identity warning instead of aliasing or rewriting delivery.

The relay server rejects duplicate live client IDs. Multiple Codex windows should therefore register distinct IDs (`CODEX2`, `CODEX3`, etc.) instead of sharing `CODEX`.

**Wrong identity at startup?** Startup resolution can pick the wrong ID when the spawning app (e.g. Codex) sets a fixed `RELAY_CLIENT_ID` and launches the MCP process from a cwd that matches no registry entry. No restart is needed to fix it: ask the session to call `relay_rename` with the correct ID (e.g. `relay_rename to=CODEX1`). The MCP client re-registers with the relay server under the new ID (the server drops the old identity from its live peer list immediately) and rewrites the local registry entry. If the target ID is live on another connection, the newest registration wins and the stale holder is displaced.

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
`RELAY_ADMIN_CLIENT_IDS=CODEX2,CC2`, then use `relay_purge_history` from one of
those exact live client IDs. Without an allowlist, durable purge is disabled.

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
```

### SSH Tunnel (on remote machines)

```bash
# Install autossh
brew install autossh

# Copy and edit the tunnel LaunchAgent
cp com.claude-relay-tunnel.plist ~/Library/LaunchAgents/

# Edit to set your server hostname and paths

# Load it
launchctl load ~/Library/LaunchAgents/com.claude-relay-tunnel.plist
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
