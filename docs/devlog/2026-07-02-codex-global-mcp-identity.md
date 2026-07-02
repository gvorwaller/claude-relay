# 2026-07-02 - Codex Global MCP Identity Collision

## Summary

Codex Desktop is using the `claude-relay` MCP from the global Codex config, not
from a per-repo MCP setup. That means multiple Codex contexts can all fall back
to the same relay identity, `CODEX`, unless a stronger identity source is
provided.

This differs from the current Claude Code usage pattern, where project-local
MCP configuration and/or a shell-provided `CLAUDE_RELAY_SESSION_ID` commonly
sets distinct session IDs such as `CC6`.

## What I Observed

Codex Desktop exposes `claude-relay` via:

```toml
# /Users/gaylonvorwaller/.codex/config.toml
[mcp_servers."claude-relay"]
command = "node"
args = ["/Users/gaylonvorwaller/claude-relay/mcp-server.js"]

[mcp_servers."claude-relay".env]
RELAY_CLIENT_ID = "CODEX"
RELAY_URL = "ws://localhost:9999"
```

When the user asked about `claude-relay`, Codex did not install anything in the
Birds repo. Codex tool discovery simply exposed the already-configured global
MCP server.

The spawned relay MCP process had:

```text
RELAY_CLIENT_ID=CODEX
RELAY_URL=ws://localhost:9999
```

It did not have a repo/session-specific `CLAUDE_RELAY_SESSION_ID`.

## Why It Became `CODEX`

`mcp-server.js` resolves the client identity in this order:

1. `CLAUDE_RELAY_SESSION_ID`
2. `--client-id`
3. single matching registry/cwd entry, such as `CODEX3`
4. `RELAY_CLIENT_ID`
5. generated host/pid ID

For this Codex Desktop MCP process, the first three were absent or did not
match. It therefore used the global fallback:

```text
Source: RELAY_CLIENT_ID
ID: CODEX
```

`relay_sessions` showed this live Codex Desktop MCP as:

```text
CODEX (this session) [ONLINE]
  CWD: /Users/gaylonvorwaller/madonnahist
  Source: RELAY_CLIENT_ID
```

The local registry also had `CODEX2` and `CODEX3` entries from Warp/Codex CLI
sessions, but those were not live from this MCP server's point of view:

```text
CODEX3 - CWD: /Users/gaylonvorwaller/trips
CODEX2 - CWD: /Users/gaylonvorwaller/listsurf
```

## Problem

Several separate Codex CLI/Warp sessions are intentionally assigned distinct
relay IDs (`CODEX2`, `CODEX3`, etc.). Codex Desktop, however, uses the shared
`~/.codex/config.toml` MCP definition and falls back to generic `CODEX`.

That can create identity collisions or shadowing:

- a Codex Desktop session may register as `CODEX`;
- a Warp/Codex CLI session may also be expected to use a Codex-related ID;
- registered `CODEX2` / `CODEX3` sessions may appear stale/offline if their
  MCP process actually connects as generic `CODEX`;
- direct sends to `CODEX2` / `CODEX3` can fail or appear invisible if the live
  WebSocket client is really `CODEX`.

The relay server is designed to reject duplicate live client IDs, so sharing
`CODEX` is not a viable multi-session strategy.

## Likely Fix Direction

Do not rely on global `RELAY_CLIENT_ID=CODEX` when more than one Codex session
can exist.

Possible fixes:

- Give each Codex session an explicit `CLAUDE_RELAY_SESSION_ID` before its MCP
  server starts, e.g. `CODEX2`, `CODEX3`, etc.
- Add a Codex-specific wrapper around `mcp-server.js` that chooses a unique ID
  based on the active Codex workspace/thread/session.
- Change the global Codex config to avoid a generic fixed fallback, or pass a
  distinct `--client-id` where possible.
- Harden `mcp-server.js` so a configured base ID like `CODEX` refuses to fall
  back to generic `CODEX` when numbered registry entries exist but none match
  the current cwd.

The main conceptual point: Codex MCP configuration is common/global here, not
per current repo. Any identity strategy that assumes a repo-local MCP process
will behave like Claude Code is likely to break for Codex Desktop.
