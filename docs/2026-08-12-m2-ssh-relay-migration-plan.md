# M2 SSH-Only Claude Relay Migration Plan

Date: 2026-08-12

Target: `Gaylon-M2-2022.local` (`ssh Mprd`)

Relay server: `Gaylon-M4-2025.local`

## Objective

Move M2's Claude Code relay connection from plaintext LAN WebSocket traffic to
an authenticated SSH tunnel without changing or restarting the production
BTC-dashboard application.

After migration:

- M4 is the only relay server.
- M4's relay listens only on `127.0.0.1:9999`.
- M2's `127.0.0.1:9999` is an SSH local-forward to M4's
  `127.0.0.1:9999`.
- M2 Claude Code MCP bridges use `ws://127.0.0.1:9999`.
- M2 no longer runs `com.claude-relay` as a local server.
- Direct LAN access to M4 port 9999 is unavailable.

## Production safety boundary

BTC-dashboard is production on M2. The pre-migration baseline observed on
2026-08-12 is:

- PM2 application `btc-dashboard` is `online`, PID 2573, with 49 days uptime
  and zero restarts.
- Its server listens on TCP 3001.
- Its server and workers run with the existing executable
  `/Users/gaylonvorwaller/.nvm/versions/node/v24.3.0/bin/node`.

The relay migration must not:

- run `nvm install`, `nvm use`, `brew install node`, or change the default Node
  version;
- create or alter `/usr/local/bin/node` or `/opt/homebrew/bin/node` symlinks;
- run `npm install`, `npm update`, or change dependencies in BTC-dashboard;
- run any PM2 start, stop, restart, reload, resurrect, save, or startup command;
- modify the BTC-dashboard checkout, environment, launch configuration, or
  TCP 3001 listener;
- kill or signal PID 2573 or its worker processes.

The absolute Node path in the Claude MCP configuration is only an executable
reference for that MCP child. It is the same already-installed binary PM2 is
using, but configuring Claude to execute it does not modify the binary, NVM,
PM2, or the running BTC-dashboard processes.

Use macOS's existing `/usr/bin/ssh` for the tunnel. Do not install `autossh` or
any Homebrew package for this migration. `launchd` supplies restart behavior;
SSH `ServerAliveInterval` and `ServerAliveCountMax` detect a broken connection.

If any BTC baseline check changes unexpectedly, stop immediately and roll back
the relay-only step just performed.

## Current M2 findings

- M2 runs an obsolete local relay launch agent, `com.claude-relay`, listening
  on `*:9999`.
- The active Claude Code relay MCP process connects directly to
  `ws://192.168.22.241:9999`.
- Relay MCP entries exist in the local/project scope for both
  `~/BTC-dashboard` and `~/claude-relay`.
- The M2 relay checkout is 44 commits behind M4's committed checkout and has
  one local change to `com.claude-relay.plist` for the NVM Node path.
- Passwordless batch SSH from M2 to M4 works using `192.168.22.241`.
- The tunnel template's example host `m1` does not resolve on M2.
- M2 has no global Claude Code Stop hook and no active relay watcher.
- `~/.claude.json` is mode `0644` even though it contains credentials.

## Phase 0: Release prerequisite on M4

1. Finish review of the pending relay changes on M4.
2. Commit and push the reviewed relay code.
3. Record the exact release commit.
4. Do not restart M4's relay yet. Its existing listener permits the new M2
   tunnel to be tested before M4 is restricted to loopback.

Gate:

- The release commit is pushed and tests are green.
- M4's existing relay remains available during M2 preparation.

## Phase 1: Capture non-invasive baselines

Before every mutating M2 step, record:

```bash
ssh Mprd 'zsh -lic "pm2 list --no-color"'
ssh Mprd 'lsof -nP -iTCP:3001 -sTCP:LISTEN'
ssh Mprd 'ps -p 2573 -o pid,ppid,lstart,command'
ssh Mprd 'git -C ~/claude-relay status --short --branch'
ssh Mprd 'launchctl list | grep claude-relay || true'
ssh Mprd 'lsof -nP -iTCP:9999'
```

Store the observed BTC PID, uptime/restart count, and TCP 3001 listener for
comparison. A PID change is not automatically caused by this work, but it is a
stop condition requiring investigation before proceeding.

Gate:

- BTC-dashboard remains online with the same PID and restart count.
- TCP 3001 remains available.

## Phase 2: Safely update only the relay checkout

M2's tracked plist customization must not be silently discarded. It becomes
unnecessary once M2 stops hosting a relay server, but keep it recoverable:

```bash
ssh Mprd 'git -C ~/claude-relay stash push \
  -m "M2 retired local relay Node-path plist" -- com.claude-relay.plist'
ssh Mprd 'git -C ~/claude-relay pull --ff-only origin main'
```

Do not run `npm install`: this release adds no external dependency needed by
the MCP bridge. Verify the checked-out commit and rerun the BTC baseline.

Keep the stash through the migration and observation window. Do not drop it as
part of the cutover.

Gate:

- Relay checkout matches the recorded M4 release commit.
- BTC PID, restart count, and TCP 3001 listener are unchanged.

## Phase 3: Prepare SSH without occupying port 9999

Add a dedicated M2 SSH alias, using the already-working M4 address and default
SSH identity:

```sshconfig
Host relay-m4
    HostName 192.168.22.241
    User gaylonvorwaller
    BatchMode yes
    ConnectTimeout 10
    ServerAliveInterval 30
    ServerAliveCountMax 3
```

Verify without changing relay traffic:

```bash
ssh Mprd 'ssh -o BatchMode=yes relay-m4 hostname'
```

Prepare, but do not bootstrap, an M2 LaunchAgent using `/usr/bin/ssh`:

```text
/usr/bin/ssh
-N
-o BatchMode=yes
-o ExitOnForwardFailure=yes
-o ServerAliveInterval=30
-o ServerAliveCountMax=3
-L 127.0.0.1:9999:127.0.0.1:9999
relay-m4
```

The agent should use `RunAtLoad`, `KeepAlive`, and bounded log files under
`~/claude-relay/logs`. It cannot start yet because M2's obsolete relay server
still owns port 9999.

Gate:

- Batch SSH reaches M4.
- The prepared plist passes `plutil -lint`.
- No Node, NVM, PM2, BTC, or existing relay process has changed.

## Phase 4: Stop Claude Code and retire only M2's relay server

Ask the operator to exit the active M2 Claude Code process cleanly. Do not
kill it remotely. Confirm its MCP child has exited.

Then retire only the M2 relay launch agent:

```bash
ssh Mprd 'launchctl bootout \
  "gui/$(id -u)/com.claude-relay"'
```

Move the old installed plist to a dated backup rather than deleting it. Verify
that nothing is listening on M2 port 9999, then rerun the BTC baseline.

Rollback at this point:

- Move the saved plist back.
- Bootstrap `com.claude-relay` again.
- Confirm the old local server owns port 9999.

Gate:

- The old relay PID is gone and M2 port 9999 is free.
- BTC PID, restart count, and TCP 3001 listener are unchanged.

## Phase 5: Start and prove the SSH tunnel

Bootstrap the prepared tunnel LaunchAgent:

```bash
ssh Mprd 'launchctl bootstrap \
  "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/com.claude-relay-tunnel.plist"'
```

Verify:

```bash
ssh Mprd 'launchctl print \
  "gui/$(id -u)/com.claude-relay-tunnel" | grep "state ="'
ssh Mprd 'lsof -nP -iTCP:9999'
ssh Mprd 'nc -G 2 -zv 127.0.0.1 9999'
```

The listener on M2 port 9999 must belong to `ssh`, bind only to loopback, and
forward to M4. It must not be a Node relay server.

Rollback:

```bash
ssh Mprd 'launchctl bootout \
  "gui/$(id -u)/com.claude-relay-tunnel"'
```

Then restore the old relay launch agent if needed.

Gate:

- M2 loopback port 9999 is owned by `/usr/bin/ssh`.
- Tunnel logs show no bind, authentication, or reconnect errors.
- BTC baseline is unchanged.

## Phase 6: Change Claude MCP configuration only

Use Claude's supported `claude mcp remove/add` commands from each affected
project instead of hand-editing the 47 KB `~/.claude.json` file.

For both `~/BTC-dashboard` and `~/claude-relay`, configure:

- scope: `local`;
- name: `claude-relay`;
- command:
  `/Users/gaylonvorwaller/.nvm/versions/node/v24.3.0/bin/node`;
- argument: `/Users/gaylonvorwaller/claude-relay/mcp-server.js`;
- `RELAY_CLIENT_ID=M2`;
- `RELAY_URL=ws://127.0.0.1:9999`.

This command path does not switch or update Node; Claude directly executes one
existing file. Do not invoke NVM or PM2.

After Claude CLI updates the configuration:

```bash
ssh Mprd 'chmod 600 "$HOME/.claude.json"'
```

Use a sanitized parser to verify only command, arguments, `RELAY_CLIENT_ID`,
and `RELAY_URL`; never print credential-bearing environment values.

Rollback:

- Re-add the same two MCP entries with the previous LAN URL.
- Do not alter the BTC application or PM2.

Gate:

- Both MCP entries point to M2 loopback.
- The configured Node file exists and is executable.
- `~/.claude.json` is mode `0600`.
- BTC baseline is unchanged.

## Phase 7: Restart Claude Code and verify relay identity

The operator starts Claude Code again in the desired project. Confirm:

- the MCP bridge process uses the absolute existing NVM Node executable;
- the bridge connects from M2 to `127.0.0.1:9999`, not directly to M4's LAN
  port;
- the relay registers identity `M2`;
- any newly issued owner secret is stored mode `0600` under
  `~/claude-relay/sessions/owners/`.

Send one message M2 to M4 and one message M4 to M2. Verify exact-recipient
delivery and durable history.

Gate:

- Bidirectional relay traffic succeeds through the tunnel.
- No M2 process connects directly to `192.168.22.241:9999`.
- BTC baseline is unchanged.

## Phase 8: Restrict M4 to loopback and re-verify

Only after M2 works through the tunnel:

1. Restart M4's reviewed relay launch agent with `RELAY_HOST=127.0.0.1`.
2. Run `relay-health` on M4.
3. Confirm M4 port 9999 is not bound to a LAN address.
4. Confirm M2's SSH tunnel reconnects.
5. Repeat bidirectional messages.
6. Rerun the M2 BTC baseline.

Rollback:

- Restore the prior M4 relay launch configuration and restart only the relay.
- The M2 tunnel can remain configured; it also works while the prior M4 relay
  listens broadly.

Gate:

- M4 health passes.
- M2 and M4 exchange relay messages through SSH.
- Direct M2-to-M4 LAN TCP 9999 fails.
- BTC-dashboard remains online with no migration-induced restart.

## Phase 9: Claude idle-wake support

M2 currently has no global Claude Stop hook. This is separate from transport:
the tunnel and MCP work without it, but an idle Claude session will not wake
automatically for new mail.

Before installing the hook, update `relay-stop-hook.sh` to accept an explicit
`RELAY_NODE_BIN` and use it for its timestamp and watcher invocations. On M2,
set that value to the existing NVM executable. The hook must not run `nvm`,
modify the shell's default Node, or affect PM2.

Install the Stop hook once in `~/.claude/settings.json`, validate the resolved
M2 identity with `--resolve-only`, end a harmless Claude turn, and send a test
message. Confirm the hook wakes Claude and that no duplicate watcher remains.

Rollback:

- Remove only the new Stop hook entry.
- The SSH tunnel and ordinary MCP relay remain operational.

## Final acceptance

- BTC-dashboard stayed online throughout with no migration-induced PM2 restart
  and remained available on TCP 3001.
- M2 has no local Node relay server.
- M2 relay traffic uses only its loopback SSH forward.
- M4 relay listens only on loopback.
- Direct plaintext LAN TCP 9999 is unavailable.
- Both Claude MCP configurations use the tunnel.
- M2 and M4 pass bidirectional exact-recipient message tests.
- M2 Claude idle wake works, if Phase 9 is included in this release.
- The old M2 plist and git customization remain recoverable until the
  observation window is complete.

## TD disposition

- Submit `td-a259e6` after Phases 1-8 pass live.
- Close `td-0944f6` as superseded by SSH-only authenticated transport after
  direct LAN TCP 9999 is proven unavailable.
- Treat Phase 9 as a separate Claude reachability check if transport is
  released first.
