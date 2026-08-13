# Claude Relay Operator Quickstart

This is the short, local-machine guide for running claude-relay and watching
detached Codex delegates. See [README.md](README.md) for installation,
architecture, remote-machine setup, and protocol details.

## What is already automatic

- The relay server runs as the `com.claude-relay` launch agent.
- Claude Code uses the global Stop hook in `~/.claude/settings.json` to arm its
  relay listener. Existing Claude Code sessions need no per-session setup.
- A relay message addressed to a configured Codex identity can launch a
  detached delegate. The monitor displays that delegate's durable job state,
  coarse current activity, replies, and delivery status.

Check the relay server at any time:

```bash
relay-health
```

After updating server-side relay code, restart the one shared daemon once:

```bash
launchctl kickstart -k "gui/$(id -u)/com.claude-relay"
```

That restart is global; it is not something to repeat in each Claude Code or
Codex session.

## Start the activity monitor

Open a separate terminal and run:

```bash
relay-monitor
```

The monitor is the operator control center. Its screen lists every available
action and explains what it does. Use the arrow keys and Return; you do not
need to remember separate health, restart, or cleanup commands. It includes
activity, detailed health, safe relay restart, and previewed cleanup of
completed activity or durable message history.

Select **Peers and sessions** to see live agent identities, background watcher
count, and each connection's reported host, client source, working directory,
and process ID. Identities still using the local credential-migration fallback
are labeled there as well.

Select **Repair owner credentials** to replace the credential for one of those
pending identities. The screen distinguishes live from offline identities and
defaults to Cancel. A live session briefly reconnects and confirms
automatically; an offline identity confirms on its next start. Its name,
messages, and activity are preserved.

The alias works from any directory and does not change the terminal's working
directory. Press `Ctrl-C` to stop it. Useful options are passed normally:

```bash
relay-monitor --owner CODEX
relay-monitor --interval 500
relay-monitor --once
```

After first adding the alias, open a new terminal or reload the shell:

```bash
source ~/.zshrc
```

## Enable Codex receipt hooks once

The activity monitor does not require a Codex hook. The hooks add durable relay
receipt facts to the owning foreground Codex task so delegated work is visible
there as well.

This machine's checked-in hook definition is
[`codex-hooks.json.example`](codex-hooks.json.example). If
`~/.codex/hooks.json` does not already exist, install it once:

```bash
cp ~/claude-relay/codex-hooks.json.example ~/.codex/hooks.json
```

Then open one Codex CLI session, run `/hooks`, and review/trust the exact
`UserPromptSubmit` and `Stop` commands. Approval is **not per session**: Codex
stores trust for the exact hook definition's hash, and subsequent sessions
reuse it. Run `/hooks` again only if the definition changes and therefore has a
new hash.

Codex sessions that were already running when `~/.codex/hooks.json` was first
installed should be restarted or resumed in a fresh CLI process once so the
new global configuration is loaded. New sessions require no additional hook
step.

If `~/.codex/hooks.json` already contains other hooks, do not overwrite it;
merge the two event definitions instead.

## Daily use

1. Leave the launch-agent relay server running.
2. Start `relay-monitor` in a spare terminal.
3. Use Claude Code and Codex normally. No command is needed in each existing
   Claude Code session, and `/hooks` is not a per-Codex-session ritual.
4. Treat `completed` as an execution result and the recorded outbound delivery
   status as transport evidence; neither is a claim that the peer accepted the
   work as correct.

## Clear old monitor entries

After upgrading the relay, restart the admin agent once so its MCP bridge reloads the new tool catalog.

`relay-monitor` reads detached-job records from `data/jobs/`, not relay message
history. For normal human use, select **Clean completed activity** in the
monitor. Choose one identity or all identities, review the count, and confirm;
active work is never included.

Select **Clean message history** to remove durable messages involving one
identity, or deliberately choose all identities. The monitor shows the exact
count and defaults to Cancel before an atomic cleanup.

For agent automation, from an admin identity (`CODEX1` or `CC1` in this installation), call
`relay_delegate_jobs` with an exact owner such as `CODEX1`. Review its counts,
then pass the returned confirmation token and the same owner to
`relay_purge_delegate_jobs`. Owner `all` is supported for a deliberate global
cleanup. The token expires whenever the selection changes, and active jobs are
never deleted.

## Troubleshooting

- **`relay-monitor: command not found`:** open a new shell or run
  `source ~/.zshrc`.
- **No delegate jobs appear:** check the launch agent, then inspect
  `~/claude-relay/logs/relay-error.log`.
- **`relay-health` fails:** resolve every `FAIL` before relying on detached
  wakes. `WARN` indicates degraded optional behavior such as no notify config.
- **Codex says a hook is untrusted or skips it:** run `/hooks` and review the
  current definition. A changed command produces a new hash and needs approval.
- **Claude Code is not waking:** confirm its global Stop hook still points to
  `~/claude-relay/scripts/relay-stop-hook.sh`; do not install a separate hook in
  every session.

## Recover a lost owner capability

Stop the affected Claude Code or Codex session, then rotate its label locally
on the relay-server Mac:

```bash
cd ~/claude-relay
npm run owner -- rotate CODEX3
```

The command refuses a live owner. `--force` is available for deliberate
emergency displacement and terminates the old connection. The replacement is
written atomically to `sessions/owners/CODEX3.secret` with mode `0600`; no
secret is printed. Restart the affected session afterward. An interrupted
rotation is completed automatically from a private journal at server startup.
