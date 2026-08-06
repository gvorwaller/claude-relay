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
already durable and every client reconnects within ~5 seconds, but a
`relay_wait` open at that instant returns `disconnect` and needs re-arming. Do
it in a quiet window.

## Verifying a release

After a restart, confirm the fail-closed controls are actually operational —
a control that cannot run is an outage, not security:

```bash
grep -h "server_listening\|ancestry_binding" logs/$(ls -t logs | grep -v wake | head -1) | tail -2
```

`delegate_ancestry_binding_ready` means delegate wakes can authenticate.
`delegate_ancestry_binding_unavailable` means every Codex wake will be refused
(this happened once because the launchd plist's PATH omitted `/usr/sbin`,
where `lsof` lives).
