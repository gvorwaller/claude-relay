# Headless AGY relay wake delegate

## Decision

AGY uses the same fresh-delegate isolation boundary as Codex and Grok. A relay
notification must never continue or attach to the visible AGY conversation:
that would create two writers for one interactive session. Instead,
`wake-peer.sh` routes `AGY*` identities to `wake-agy.sh`, which starts one
noninteractive `agy -p` worker in the registered working directory.

## MCP configuration

AGY 1.1.13 reads global MCP servers from
`~/.gemini/config/mcp_config.json`. The installed local entry runs
`/Users/gaylonvorwaller/claude-relay/mcp-server.js` with
`RELAY_CLIENT_ID=AGY`. AGY hot-loaded the entry in the already-running Warp
session and a real `relay_status` call reported identity `AGY`. AGY then
cleanly closed that stdio bridge after the tool-using turn; unlike Claude Code,
it does not promise a continuously connected MCP subprocess while idle. The
control center therefore renders the durable `AGY` registry entry as a
registered idle session between turns and shows `AGY~wake-*` only while a
delegate is actually running.

## Delegate contract

- `RELAY_DELEGATE_FOR=AGY` gives the worker a derived `AGY~wake-*` connection;
  it cannot own or displace the foreground identity.
- `agy -p` is always fresh: no `--continue` or `--conversation` is used.
- `--dangerously-skip-permissions` is confined to this deliberate one-shot
  worker because print mode cannot stop for permission prompts.
- `--output-format stream-json` is projected into fixed activity categories.
  Prompts, reasoning, commands, tool arguments, tool output, and relay message
  bodies are not stored in the activity stream.
- The final response is constrained by `delegate-result-schema.json` and
  submitted through the existing job capability/result-secret path.
- The worker drains current durable mail and exits; it never opens
  `relay_wait`. Existing single-flight and trailing-wake logic handles mail
  arriving while it runs.

## Verification

- AGY noninteractive structured-output smoke test succeeded.
- Global MCP discovery and live `relay_status` call succeeded as `AGY`.
- Focused delegate visibility tests passed, including projection, fresh-worker
  invocation, dispatcher routing, and final-result capture.
- Live E2E sent disposable relay mail to `AGY`; the headless worker replied
  with exact token `AGY_WAKE_OK`, the job completed with a delivered outbound
  fact and sanitized timeline, and the disposable sender enrollment was
  removed automatically.
