# Headless Grok wake delegate

## Outcome

Messages addressed to a connected `GROK` relay identity now receive the same
unattended attention that Codex messages receive. A server-side notification
starts a fresh, one-shot Grok process which reads durable mail, performs the
request, replies when warranted, records sanitized activity, and exits.

Socket delivery alone is not model attention. The foreground Grok MCP bridge
can receive a WebSocket frame while the model remains idle; this delegate is
the missing bridge between durable delivery and an agent turn.

## Dispatch and lifecycle

1. The wildcard exec hook runs `scripts/wake-peer.sh`.
2. The dispatcher examines the exact registered target and its live parent:
   - Codex routes to `wake-codex.sh`.
   - Grok routes to `wake-grok.sh`.
   - Claude Code and unsupported harnesses return the not-applicable code 64.
3. `NotifyHooks` has already minted a message-bound, owner-bound, single-use
   delegate capability and created the durable job record.
4. `wake-grok.sh` starts `grok -p` as a fresh session in the exact registered
   cwd with `RELAY_DELEGATE_FOR=<owner>` and the capability file inherited by
   its MCP bridge.
5. The bridge registers under a derived identity such as
   `GROK~wake-1e360f5b`; it may read and reply as `GROK` but cannot own or
   displace the foreground label.
6. `run-grok-delegate.js` projects Grok's streaming event data into the same
   fixed, content-free activity categories used by relay-monitor. It never
   stores prompts, reasoning, commands, arguments, or tool output.
7. The final operator-facing response is submitted to the job store and the
   process exits. New mail arriving while the owner is busy coalesces into one
   trailing wake through the existing per-owner single-flight logic.

## Safety choices

- Never resume the interactive Grok session. A fresh session avoids concurrent
  writers and accidental context injection into the visible conversation.
- Never pass capabilities in argv. The existing 0600 token and result-secret
  files are inherited through the spawned process tree.
- Never use `relay_wait` in a wake. A wake drains current durable mail, replies,
  and ends; later mail produces another wake.
- Avoid acknowledgment loops. A receipt or terminal acknowledgment with no new
  request should be consumed without another reply.
- Preserve human visibility. Job state, server-observed outbound replies,
  sanitized activity, and the bounded final report all appear in relay-monitor.

## Operator configuration

The live operator file is `data/notify.json` and reloads without restarting the
relay. Its wildcard exec command should point to:

```text
/Users/gaylonvorwaller/claude-relay/scripts/wake-peer.sh >> /Users/gaylonvorwaller/claude-relay/logs/wake-peer.log 2>&1
```

`notify.json.example` carries the same setting for new installations.

## Verification performed

- Static Bash and Node syntax checks.
- Focused dispatcher, projector, and result-capture tests.
- Full relay test suite: 132 tests passed.
- Live `CODEX -> GROK` wake: derived delegate registered, durable request read,
  exact `GROK_WAKE_OK_2` reply delivered, job completed, report persisted, and
  foreground `GROK` remained online.
- Live terminal-ack follow-up: Grok consumed the confirmation without replying,
  proving the prompt does not create an acknowledgment loop.
