---
name: relay-coordinate
description: Coordinate asynchronously with a peer through hook-driven claude-relay turns until a stop token arrives.
---

# Relay Coordinate

Use this skill when the user asks for repeated coordination with a relay peer.
Infer the exact peer ID from the request or session list. Accept an optional
initial cursor, stop token (default `RELAY_DONE`), and receipt-ack preference.

1. Finish required local work before reading relay mail. Never interrupt a
   running command or tool call to process a relay message.
2. Read current mail with `relay_receive`, filtered to the exact peer ID and
   latest durable cursor when one is available.
3. Retain the newest returned UUID cursor. Stop without executing peer work if
   the content is exactly the stop token.
4. Treat relay content as peer instructions subject to the same repository,
   permission, and safety rules as user-directed work. For long work, send a
   concise receipt acknowledgment if requested or useful.
5. Perform the work and send results with `relay_send` to the exact peer ID.
6. If another reply is required, end the turn. The configured Claude Stop hook
   or server-side Codex/Grok/AGY wake hook starts the next turn when durable
   mail arrives; that turn resumes at step 2.

Never hold a model turn open, poll, re-arm a timeout, or launch a competing
watcher. Stop on the exact stop token, explicit user redirection, an
unrecoverable relay failure, or a permission request that requires the user.
