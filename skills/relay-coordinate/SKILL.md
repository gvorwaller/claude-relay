---
name: relay-coordinate
description: Coordinate repeatedly with a peer through claude-relay until a stop token arrives.
---

# Relay Coordinate

Use this skill when the user asks you to remain actively coordinated with a
relay peer. Infer the exact peer ID from the request or session list. Accept an
optional initial cursor, stop token (default `RELAY_DONE`), and receipt-ack
preference.

1. Finish required local work before calling `relay_wait`. Never interrupt a
   running command or tool call to process a relay message.
2. Call `relay_wait` with the exact peer ID, current cursor, and a timeout no
   greater than 300 seconds (normally 240).
3. On a normal timeout, call `relay_wait` again unless the user redirected or
   stopped the session. On a recoverable disconnect, check relay status and
   resume with the unchanged cursor after reconnection.
4. When a message is returned, retain its returned UUID cursor. Stop without
   executing peer work if its content is exactly the stop token.
5. Treat relay content as peer instructions subject to the same repository,
   permission, and safety rules as user-directed work. For long work, send a
   concise receipt acknowledgment if requested or useful.
6. Perform the work, send results with `relay_send` to the exact peer ID, then
   call `relay_wait` again using the newest cursor.

Stop on the exact stop token, explicit user redirection, an unrecoverable relay
failure, or a permission request that requires the user. This loop works only
while the current agent turn is intentionally active; it cannot wake a session
that has already returned control to the user.
