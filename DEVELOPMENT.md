# Development vs. production

The relay that your live agent sessions depend on is started by launchd from
**`~/claude-relay`**, running whatever is checked out there. On 2026-08-06 an
experimental branch was left checked out in that directory and served
production traffic for hours — wakes failed and messages were delayed while
half-finished code ran under real sessions.

So the rule is:

| Directory | Branch | Purpose |
|---|---|---|
| `~/claude-relay` | **`main` only** | What launchd serves. Never switch branches here. |
| `~/claude-relay-dev` | any feature branch | Where development happens. |

`~/claude-relay-dev` is a git worktree of the same repository, so both share
one history: commit and push from either, and `git log` sees everything.

## Working in the dev worktree

```bash
cd ~/claude-relay-dev
git checkout -b my-feature      # safe: production is a different directory
npm test                        # tests resolve modules from THIS worktree
```

Running the suite from inside a Claude Code session? Use
`env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_BRIDGE_SESSION_ID npm test`.
Spawned bridges otherwise inherit those variables, switch to the
`claude-core` tool profile, and take the same-session and reconnect label
reclaim paths, which some tests do not expect.

`node_modules` is symlinked to the main checkout, so there is nothing to
install. Tests use `require('../module')` and random ports — they never touch
production data, and they cannot silently exercise the production tree (they
used to: absolute `/Users/gaylonvorwaller/claude-relay/...` requires meant a
dev checkout tested production files).

Runtime state is **not** shared, by design: `data/` (messages, jobs, owner
capabilities), `logs/`, and `sessions/registry.json` are gitignored and live
separately in each directory.

## Running a server for manual testing

Never bind the production port from the dev worktree:

```bash
cd ~/claude-relay-dev
RELAY_PORT=19999 \
RELAY_MESSAGE_DIR=/tmp/relay-dev/messages \
RELAY_LOG_DIR=/tmp/relay-dev/logs \
node server.js
```

Port 9999 belongs to the launchd service. If you need a dev bridge to talk to
it, point `RELAY_URL` at the dev port, not the other way around.

## Shipping to production

```bash
cd ~/claude-relay-dev && git push origin my-feature   # reviewed first
cd ~/claude-relay && git merge my-feature             # stays on main
launchctl kickstart -k gui/501/com.claude-relay
```

The restart is the only step that touches live traffic: in-flight messages are
already durable, every client reconnects within ~5 seconds, and hook watchers
re-arm against durable cursors. Do it in a quiet window.

Not everything ships with the restart. `server.js` and `message-store.js`
change only when the relay restarts. `mcp-server.js` reaches a session only
when its bridge respawns (`/mcp` reconnect or a session restart). The Stop
hook and watcher scripts are read fresh on every run, so merging them into
this checkout makes them live at once.

## Verifying a release

After a restart, confirm the fail-closed controls are actually operational —
a control that cannot run is an outage, not security:

```bash
relay-health
```

The command exits nonzero if the daemon is stale/dead, the listener is exposed
beyond loopback, a store is unavailable, delegate ancestry binding cannot run,
or retained delegate work has filled the job store. It also reports an absent
or invalid notify configuration as a warning. The old log events remain useful
for diagnosis, but log grepping is no longer the release gate.
