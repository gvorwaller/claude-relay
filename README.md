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

---

## MCP Tools

Once configured, Claude Code will have these tools:

| Tool | Description |
|------|-------------|
| `relay_send` | Send a message to peer Claude Code instance(s) |
| `relay_receive` | Get recent messages from peers |
| `relay_peers` | List currently connected instances |
| `relay_status` | Check connection health |
| `relay_sessions` | List all registered sessions (including offline) |
| `relay_clear_history` | Clear relay message history from server memory |

### Example Usage

**Send a message:**
```
Use relay_send to tell CC-2: "Found the bug - it's in auth.js line 42"
```

**Check for messages:**
```
Use relay_receive to see if there are any messages from peers
```

**See who's online:**
```
Use relay_peers to list connected instances
```

**View all registered sessions:**
```
Use relay_sessions to see all Claude sessions, online and offline
```

**Clear relay message history:**
```
Use relay_clear_history to clear in-memory relay message history
```

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
├── test-client.js            # Interactive test client
├── package.json              # Node.js dependencies
├── sessions/
│   ├── register.sh           # Shell script to register session ID
│   ├── list.sh               # Shell script to list sessions
│   └── registry.json         # Session registry (auto-generated)
├── logs/
│   ├── relay.log             # Relay server logs
│   └── relay-error.log       # Relay server errors
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
