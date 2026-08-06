#!/usr/bin/env node
/**
 * Claude Relay Server
 *
 * WebSocket relay that enables real-time communication between
 * Claude Code instances on M1 and M2.
 *
 * Usage: node server.js [port]
 * Default port: 9999
 */

const path = require('path');
const { randomUUID } = require('crypto');
const { execFileSync, execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const { MessageStore } = require('./message-store');
const { OperationalLogger } = require('./operational-logger');
const { NotifyHooks } = require('./notify-hooks');
const { CapabilityStore } = require('./capabilities');
const { DelegateJobStore } = require('./delegate-job-store');

const PORT = parseInt(process.argv[2] || process.env.RELAY_PORT || '9999', 10);
const MESSAGE_RETENTION_DAYS = parseInt(process.env.RELAY_MESSAGE_RETENTION_DAYS || '7', 10);
const MESSAGE_MAX_DISK_MB = parseInt(process.env.RELAY_MESSAGE_MAX_DISK_MB || '100', 10);
const CACHE_MAX_MESSAGES = parseInt(process.env.RELAY_CACHE_MAX_MESSAGES || '500', 10);
const CACHE_MAX_MB = parseInt(process.env.RELAY_CACHE_MAX_MB || '10', 10);
const ADMIN_CLIENT_IDS = new Set(
  (process.env.RELAY_ADMIN_CLIENT_IDS || '').split(',').map(value => value.trim()).filter(Boolean)
);

const messageStore = new MessageStore({
  dataDir: process.env.RELAY_MESSAGE_DIR,
  retentionDays: MESSAGE_RETENTION_DAYS,
  maxDiskBytes: MESSAGE_MAX_DISK_MB * 1024 * 1024,
  maxCacheMessages: CACHE_MAX_MESSAGES,
  maxCacheBytes: CACHE_MAX_MB * 1024 * 1024
});
messageStore.initialize();
const logger = new OperationalLogger({
  logDir: process.env.RELAY_LOG_DIR,
  retentionDays: parseInt(process.env.RELAY_LOG_RETENTION_DAYS || '7', 10),
  maxTotalBytes: parseInt(process.env.RELAY_LOG_MAX_TOTAL_MB || '50', 10) * 1024 * 1024,
  maxFileBytes: parseInt(process.env.RELAY_LOG_MAX_FILE_MB || '10', 10) * 1024 * 1024
});
const capabilities = new CapabilityStore({
  dataDir: process.env.RELAY_MESSAGE_DIR
    ? path.dirname(process.env.RELAY_MESSAGE_DIR)
    : path.join(__dirname, 'data'),
  logger
});
// Enrollment policy for a label's FIRST claim (a first-come rule would let a
// squatter on the open port receive a label's durable authority):
//   loopback  -> auto-enroll (the local machine is the trusted channel)
//   remote    -> requires RELAY_ENROLL_SECRET
// Labels already enrolled always require their owner capability from remote
// clients; a local client may still fall back to the pid rules (migration).
const ENROLL_SECRET = process.env.RELAY_ENROLL_SECRET || null;
const REQUIRE_OWNER_CAPABILITY = process.env.RELAY_REQUIRE_OWNER_CAPABILITY === '1';
// Second factor for delegate registration: the claimant must live inside the
// process tree the server spawned. Defaults ON; set to '0' only where process
// ancestry is unavailable (some sandboxes) or for synthetic test delegates.
const BIND_DELEGATE_ANCESTRY = process.env.RELAY_BIND_DELEGATE_ANCESTRY !== '0';

const jobStore = new DelegateJobStore({
  dataDir: process.env.RELAY_MESSAGE_DIR
    ? path.join(path.dirname(process.env.RELAY_MESSAGE_DIR), 'jobs')
    : path.join(__dirname, 'data', 'jobs'),
  logger
}).initialize();

const notifyHooks = new NotifyHooks({
  configPath: process.env.RELAY_NOTIFY_CONFIG || path.join(__dirname, 'data', 'notify.json'),
  logger,
  capabilities,
  jobStore
});

// Connected clients: Map<clientId, WebSocket>
const clients = new Map();
// Per-client metadata reported at register time: Map<clientId, meta>
// Lets any peer discover the full cluster (cwd/host/started) via get_sessions,
// not just the local machine's registry.json file.
const clientMeta = new Map();
const duplicateLogTimes = new Map();
// Content-free background watchers. Map<targetClientId, Set<WebSocket>>.
// Watchers receive only an existence ping; they never inherit target history
// visibility or message content.
const watchers = new Map();

// One strict grammar for every client-supplied identity and target (review
// finding #1: unvalidated labels flowed into shell/AppleScript sinks). `~` is
// deliberately excluded: it is reserved for server-minted delegate IDs, so a
// client can never register a name that impersonates one.
const CLIENT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
// "all" is the broadcast target; a client owning that name would let its
// delegate's reply scope become a broadcast permit (re-check #5).
const RESERVED_CLIENT_IDS = new Set(['all']);

const wss = new WebSocketServer({ host: '0.0.0.0', port: PORT });

logger.info('server_starting', { port: PORT });

wss.on('listening', () => {
  logger.info('server_listening', { port: PORT, host: '0.0.0.0' });
  if (BIND_DELEGATE_ANCESTRY) {
    // A fail-closed control that cannot run is an outage, so say so at
    // startup instead of refusing every wake in silence.
    peerPidForPort(PORT).then(() => {
      try {
        require('fs').accessSync(LSOF_PATH, require('fs').constants.X_OK);
        logger.info('delegate_ancestry_binding_ready', { lsof: LSOF_PATH });
      } catch {
        logger.error('delegate_ancestry_binding_unavailable', {
          lsof: LSOF_PATH,
          impact: 'every delegate wake will be refused; set RELAY_BIND_DELEGATE_ANCESTRY=0 or fix PATH'
        });
      }
    });
  }
});

wss.on('connection', (ws, req) => {
  let clientId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  logger.info('connection_opened', { remoteAddress: req.socket.remoteAddress });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'register':
          // Client identifies itself (M1, M2, etc.)
          // No silent "unknown" fallback: every nameless client used to land
          // on that one shared label and displace the others. A client must
          // name itself, validly.
          const requestedClientId = typeof msg.clientId === 'string' ? msg.clientId : '';
          const clientIdAtEntry = clientId;
          if (ws.registrationInFlight) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'A registration is already being processed on this connection'
            }));
            return;
          }
          if (RESERVED_CLIENT_IDS.has(requestedClientId.toLowerCase())) {
            ws.send(JSON.stringify({
              type: 'error',
              message: `"${requestedClientId}" is a reserved name and cannot be a client ID`
            }));
            logger.warn('register_reserved_client_id', { requestedClientId });
            return;
          }
          if (!CLIENT_ID_PATTERN.test(requestedClientId)) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Invalid client ID: use letters, digits, "-" or "_", starting with a letter (max 64 chars)'
            }));
            logger.warn('register_invalid_client_id', { remoteAddress: req.socket.remoteAddress });
            return;
          }

          // Delegate registration: a helper the server's own wake hook spawned
          // (e.g. a resumed headless Codex run) that must read and answer mail
          // for an existing label WITHOUT owning it. It gets a visibly derived
          // ID and never contests the base label, so the interactive session
          // holding that label is untouched.
          if (msg.delegate === true) {
            if (!isLoopback(req.socket.remoteAddress)) {
              ws.send(JSON.stringify({
                type: 'error',
                message: 'Delegate registration is only permitted from the relay host'
              }));
              return;
            }
            if (clientId) {
              // A registered connection — primary OR delegate — may never
              // change identity: switching modes stranded the old mapping,
              // and delegate→delegate left a stale entry behind (review
              // finding #10 and its re-check). Delegates are immutable;
              // fresh connections only.
              ws.send(JSON.stringify({
                type: 'error',
                message: ws.delegateOf
                  ? `This connection is already a delegate of "${ws.delegateOf}"; delegates are immutable`
                  : `Already registered as "${clientId}"; delegate registration requires a fresh connection`
              }));
              return;
            }
            const delegateBase = String(requestedClientId);
            // Loopback is necessary but NOT sufficient (review finding #3):
            // any local process could otherwise impersonate a label, read its
            // mail, and suppress its wakes. A delegate must present the
            // single-use capability the notify path minted when it spawned
            // the wake.
            // Authorize-and-consume atomically: a failed attempt must NOT
            // spend the capability, or a thief could deny the real delegate
            // by trying once (re-check #2). Every factor is checked first.
            // OBSERVED, not asserted: ask the kernel which process owns this
            // socket. A same-user thief who reads the bearer file cannot
            // fake this — it would have to actually be inside the wake's
            // process tree.
            // Reject junk before doing any expensive work: an unknown token
            // must cost nothing (re-check #2).
            if (!capabilities.hasJob(msg.jobToken)) {
              ws.send(JSON.stringify({
                type: 'error',
                message: 'Delegate registration requires a valid, unexpired job capability'
              }));
              logger.warn('delegate_capability_rejected', {
                delegateOf: delegateBase,
                reason: 'unknown',
                remoteAddress: req.socket.remoteAddress
              });
              return;
            }
            const observedPid = BIND_DELEGATE_ANCESTRY
              ? await peerPidForPort(req.socket.remotePort)
              : null;
            // The token could have been consumed or revoked while we looked.
            if (ws.readyState !== 1 || clientId) return;
            const authorized = capabilities.authorizeJob(msg.jobToken, delegateBase, jobRecord => {
              if (!BIND_DELEGATE_ANCESTRY) return true;
              // Fail closed when the binding cannot be evaluated: neither a
              // wake with no recorded pid nor an unidentifiable peer may
              // downgrade to bearer-only.
              if (!jobRecord.spawnPid || !observedPid) return false;
              return isDescendantOf(observedPid, jobRecord.spawnPid);
            });
            if (!authorized.ok) {
              ws.send(JSON.stringify({
                type: 'error',
                message: authorized.reason === 'verification-failed'
                  ? 'Delegate registration must come from the spawned wake process tree'
                  : 'Delegate registration requires a valid, unexpired job capability'
              }));
              logger.warn('delegate_capability_rejected', {
                delegateOf: delegateBase,
                reason: authorized.reason,
                observedPid: observedPid || null,
                remoteAddress: req.socket.remoteAddress
              });
              return;
            }
            const job = authorized.job;
            // Suffix is a server-generated nonce: no client-supplied text
            // (previously meta.pid) may appear in a minted identity.
            const delegateId = `${delegateBase}~wake-${randomUUID().slice(0, 8)}`;
            // Least authority: the delegate may read only mail from its
            // inbound message onward, never the label's full history.
            ws.delegateJob = job;
            if (job.jobId) {
              jobStore.transition(job.jobId, 'running', { delegateId, spawnPid: job.spawnPid });
            }
            // Bounded lease: a consumed token must not grant an indefinite
            // session. The socket is closed when the job's session window
            // ends, whatever the delegate is doing.
            ws.delegateLease = setTimeout(() => {
              logger.info('delegate_lease_expired', { delegateId, delegateOf: delegateBase });
              try {
                ws.send(JSON.stringify({ type: 'error', message: 'Delegate job lease expired' }));
              } catch { /* socket may already be gone */ }
              ws.terminate();
            }, Math.max(1000, job.sessionExpiresAt - Date.now()));
            if (typeof ws.delegateLease.unref === 'function') ws.delegateLease.unref();
            clientId = delegateId;
            ws.clientId = delegateId;
            ws.delegateOf = delegateBase;
            clients.set(delegateId, ws);
            clientMeta.set(delegateId, {
              ...(msg.meta && typeof msg.meta === 'object' ? msg.meta : {}),
              delegateOf: delegateBase,
              remoteAddress: req.socket.remoteAddress,
              connectedAt: new Date().toISOString()
            });
            logger.info('delegate_registered', { delegateId, delegateOf: delegateBase });
            ws.send(JSON.stringify({
              type: 'registered',
              clientId: delegateId,
              delegateOf: delegateBase,
              peers: Array.from(clients.keys()).filter(id => id !== delegateId)
            }));
            broadcast({
              type: 'peer_joined',
              clientId: delegateId,
              peers: Array.from(clients.keys())
            }, delegateId);
            break;
          }

          if (ws.delegateOf) {
            // The mirror image: a delegate must not shed its restrictions by
            // re-registering as a primary on the same socket.
            ws.send(JSON.stringify({
              type: 'error',
              message: `This connection is a delegate of "${ws.delegateOf}"; primary registration requires a fresh connection`
            }));
            return;
          }

          // Same-socket rename: this connection is already registered under a
          // different ID (relay_rename). The old identity is dropped ONLY
          // after the new label's contest is won — destroying it first left a
          // rejected renamer identity-less and unroutable (review finding #5).
          const renamedFrom =
            clientId && clientId !== requestedClientId && clients.get(clientId) === ws
              ? clientId
              : null;

          // ---- Owner capability gate -------------------------------------
          // Decides whether this connection may claim/reseat the label at
          // all, BEFORE any contest with a current holder.
          const fromLoopback = isLoopback(req.socket.remoteAddress);
          const ownerEnrolled = capabilities.hasOwner(requestedClientId);
          const presentedSecret = typeof msg.ownerSecret === 'string' ? msg.ownerSecret : null;
          const ownerProven = ownerEnrolled
            && presentedSecret
            && capabilities.verifyOwner(requestedClientId, presentedSecret);
          let mintedOwnerSecret = null;

          if (ownerEnrolled && !ownerProven) {
            // Wrong secret is always fatal. A missing secret is tolerated
            // only for a local client whose label has NEVER been claimed with
            // its capability — the bounded migration window. The moment any
            // client authenticates for that label the tolerance ends
            // permanently (self-healing strictness), and it never applies
            // under RELAY_REQUIRE_OWNER_CAPABILITY=1.
            const tolerated = !presentedSecret
              && fromLoopback
              && !REQUIRE_OWNER_CAPABILITY
              && !capabilities.isAcknowledged(requestedClientId);
            if (!tolerated) {
              ws.send(JSON.stringify({
                type: 'register_rejected',
                clientId: requestedClientId,
                reason: presentedSecret
                  ? `Owner capability for "${requestedClientId}" is invalid.`
                  : `"${requestedClientId}" is enrolled and requires its owner capability.`
              }));
              logger.warn('owner_capability_rejected', {
                clientId: requestedClientId,
                presented: Boolean(presentedSecret),
                remoteAddress: req.socket.remoteAddress
              });
              return;
            }
            logger.warn('owner_capability_missing', {
              clientId: requestedClientId,
              remoteAddress: req.socket.remoteAddress,
              note: 'local client without capability; falling back to pid rules'
            });
          }

          if (!ownerEnrolled) {
            // First claim = enrollment.
            if (!fromLoopback && (!ENROLL_SECRET || msg.enrollSecret !== ENROLL_SECRET)) {
              ws.send(JSON.stringify({
                type: 'register_rejected',
                clientId: requestedClientId,
                reason: 'Enrolling a new label from a remote host requires the enrollment secret.'
              }));
              logger.warn('enrollment_rejected', {
                clientId: requestedClientId,
                remoteAddress: req.socket.remoteAddress
              });
              return;
            }
            mintedOwnerSecret = capabilities.mintOwner(requestedClientId, {
              host: msg.meta && msg.meta.host ? msg.meta.host : null
            }).secret;
          }

          const existingClient = clients.get(requestedClientId);
          if (existingClient && existingClient !== ws && existingClient.readyState === 1) {
            // The label's socket is open. Ask the SERVER's own question —
            // "is that connection actually alive?" — instead of believing
            // the claimant's asserted pid, which is forgeable and was the
            // hole in every previous version of this contest.
            ws.registrationInFlight = true;
            let holderAlive;
            try {
              holderAlive = await probeHolder(existingClient);
            } finally {
              ws.registrationInFlight = false;
            }
            // Re-read the world after awaiting: this socket may have been
            // closed, may have registered as something else, and the label
            // may have changed hands while the probe was running (re-check
            // #1). Nothing decided before the await may be trusted now.
            if (ws.readyState !== 1) return;
            // "Registered during the await" means the identity CHANGED while
            // we waited — not merely that this socket already had one (a
            // rename legitimately re-registers an identified socket).
            if (clientId !== clientIdAtEntry) return;
            if (clients.get(requestedClientId) !== existingClient) {
              ws.send(JSON.stringify({
                type: 'register_rejected',
                clientId: requestedClientId,
                reason: `"${requestedClientId}" changed hands while your claim was being checked; retry.`
              }));
              return;
            }
            if (holderAlive) {
              const holderPid = (clientMeta.get(requestedClientId) || {}).pid || null;
              logger.warn('register_rejected_label_in_use', {
                clientId: requestedClientId,
                holderPid,
                newRemoteAddress: req.socket.remoteAddress
              });
              ws.send(JSON.stringify({
                type: 'register_rejected',
                clientId: requestedClientId,
                holderPid,
                reason: `"${requestedClientId}" is held by a live connection that answered a liveness probe. `
                  + 'A label belongs to its live session: stop that session, or register under a different ID '
                  + '(or as its delegate). The label frees itself as soon as that connection drops.'
              }));
              return;
            }
            // No answer: the holder is a corpse (crash, sleep, network drop).
            // Reclaiming it is exactly the legitimate-reconnect case.
            logger.info('unresponsive_holder_reclaimed', {
              clientId: requestedClientId,
              newRemoteAddress: req.socket.remoteAddress
            });
            try {
              existingClient.send(JSON.stringify({
                type: 'error',
                message: `Client ID ${requestedClientId} was reclaimed after this connection failed a liveness probe`
              }));
            } catch (_) { /* corpse may be unwritable */ }
            existingClient.displacedByTakeover = true;
            existingClient.terminate();
          }

          // Contest won (or uncontested): now it is safe to release the
          // renamed-from identity.
          if (renamedFrom) {
            clients.delete(renamedFrom);
            clientMeta.delete(renamedFrom);
            logger.info('client_renamed', {
              from: renamedFrom,
              to: requestedClientId,
              remoteAddress: req.socket.remoteAddress
            });
          }

          clientId = requestedClientId;
          ws.clientId = clientId;
          clients.set(clientId, ws);
          // Remember whatever metadata the client reported (cwd, host, started,
          // pid, source). Older clients omit msg.meta — store an empty object so
          // they still appear (ID-only) in the cluster session list.
          clientMeta.set(clientId, {
            ...(msg.meta && typeof msg.meta === 'object' ? msg.meta : {}),
            remoteAddress: req.socket.remoteAddress,
            connectedAt: new Date().toISOString()
          });
          logger.info('client_registered', { clientId, remoteAddress: req.socket.remoteAddress });

          // Send registration confirmation. A freshly minted owner secret is
          // returned exactly once, here; the client persists it privately and
          // presents it on every later claim of this label.
          ws.send(JSON.stringify({
            type: 'registered',
            clientId,
            peers: Array.from(clients.keys()).filter(id => id !== clientId),
            ...(mintedOwnerSecret ? { ownerSecret: mintedOwnerSecret } : {})
          }));

          // Broadcast peer update to others. On a rename, first announce the
          // old identity leaving so every peer's cached list converges.
          if (renamedFrom) {
            broadcast({
              type: 'peer_left',
              clientId: renamedFrom,
              peers: Array.from(clients.keys())
            }, clientId);
          }
          broadcast({
            type: 'peer_joined',
            clientId,
            peers: Array.from(clients.keys())
          }, clientId);
          break;

        case 'message':
          if (!clientId) {
            ws.send(JSON.stringify({ type: 'error', message: 'Register before sending messages' }));
            return;
          }
          if (typeof msg.content !== 'string') {
            ws.send(JSON.stringify({ type: 'error', message: 'Message content must be a string' }));
            return;
          }
          const to = msg.to || 'all';
          // A job delegate may answer only the peer that woke it. It is not a
          // general-purpose sender on the label's behalf, and it may never
          // broadcast (review re-check #2).
          if (ws.delegateJob) {
            const allowed = ws.delegateJob.replyTo;
            if (to === 'all' || !allowed || allowed === 'all' || to !== allowed) {
              ws.send(JSON.stringify({
                type: 'error',
                message: allowed
                  ? `This delegate job may only reply to "${allowed}"`
                  : 'This delegate job has no reply recipient'
              }));
              logger.warn('delegate_send_out_of_scope', {
                delegateId: clientId,
                attemptedTo: to,
                allowed: allowed || null
              });
              return;
            }
          }
          // Targets pass the same grammar as registrations; a currently
          // connected exact ID (e.g. a server-minted delegate) is also
          // addressable. Everything else is refused BEFORE it can reach
          // notify hooks or shell/AppleScript sinks.
          if (to !== 'all' && !CLIENT_ID_PATTERN.test(to) && !clients.has(to)) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Invalid message target: use a valid client ID or "all"'
            }));
            logger.warn('message_invalid_target', { clientId });
            return;
          }
          // A delegate speaks AS its base label: its mail is stored from the
          // base so peers see one consistent identity and the base session
          // keeps visibility of the conversation.
          const fromId = ws.delegateOf || clientId;
          // Direct mail reaches the label's owner AND any live delegates of it.
          const directSockets = [];
          if (to !== 'all') {
            const primary = clients.get(to);
            if (primary && primary.readyState === 1) directSockets.push(primary);
            for (const peer of clients.values()) {
              if (peer.delegateOf === to && peer.readyState === 1 && peer !== ws) {
                directSockets.push(peer);
              }
            }
          }
          const deliveredToDelegate = directSockets.some(peer => peer.delegateOf === to);
          const delivered = to === 'all'
            ? Array.from(clients.entries()).some(([id, peer]) => id !== clientId && peer.readyState === 1)
            : directSockets.length > 0;
          const envelope = messageStore.append({
            type: 'message',
            from: fromId,
            to,
            content: msg.content,
            delivered
          });

          if (msg.to && msg.to !== 'all') {
            for (const peer of directSockets) {
              peer.send(JSON.stringify(envelope));
            }
          } else {
            // Broadcast to all except sender
            broadcast(envelope, clientId);
          }
          // Always acknowledge honestly. An offline target used to get an
          // 'error' reply even though the message WAS durably stored and will
          // be replayed — that lie caused real triage confusion (2026-08-02
          // incident). delivered=false now means "queued", never "lost".
          ws.send(JSON.stringify({
            type: 'sent',
            id: envelope.id,
            to,
            delivered
          }));
          if (ws.delegateJob && ws.delegateJob.jobId) {
            jobStore.recordOutbound(ws.delegateJob.jobId, {
              to,
              messageId: envelope.id,
              delivered
            });
          }
          logger.info('message_recorded', {
            messageId: envelope.id,
            from: fromId,
            sentBy: fromId === clientId ? undefined : clientId,
            to,
            bytes: Buffer.byteLength(msg.content, 'utf8'),
            delivered
          });
          notifyWatchers(to, envelope.timestamp, fromId);
          notifyHooks.fire({
            to,
            from: fromId,
            messageId: envelope.id,
            delivered,
            deliveredToDelegate
          });
          break;

        case 'watch':
          if (!clientId) {
            ws.send(JSON.stringify({ type: 'error', message: 'Register before watching' }));
            return;
          }
          if (typeof msg.for !== 'string' || !CLIENT_ID_PATTERN.test(msg.for.trim())) {
            ws.send(JSON.stringify({ type: 'error', message: 'Watch target must be a valid client ID' }));
            return;
          }
          removeWatcher(ws);
          ws.watchTarget = msg.for.trim();
          if (!watchers.has(ws.watchTarget)) watchers.set(ws.watchTarget, new Set());
          watchers.get(ws.watchTarget).add(ws);
          ws.send(JSON.stringify({ type: 'watching', for: ws.watchTarget }));
          logger.info('watch_started', { clientId, for: ws.watchTarget });
          // Closing the re-arm blind window: a watcher re-subscribing every
          // ~300s is deaf between exits. With `since` (message id or ISO
          // timestamp) the server checks the store at subscribe time and pings
          // immediately if mail already arrived, so gap mail wakes the next
          // watcher the instant it arms instead of sitting silent.
          if (typeof msg.since === 'string' && msg.since.trim()) {
            const pending = messageStore.query({
              requester: ws.watchTarget,
              after: msg.since.trim(),
              count: 50
            }).messages.filter(m =>
              m.from !== ws.watchTarget && (m.to === ws.watchTarget || m.to === 'all'));
            if (pending.length > 0) {
              ws.send(JSON.stringify({
                type: 'new_message',
                for: ws.watchTarget,
                at: pending[pending.length - 1].timestamp,
                pending: pending.length
              }));
              logger.info('watch_backfill_ping', {
                clientId,
                for: ws.watchTarget,
                pending: pending.length
              });
            }
          }
          break;

        case 'get_receipts': {
          // What did my delegates do while I was away? Owner-scoped: a
          // session sees only its own jobs, and a delegate may not ask at
          // all (it would be reporting on itself).
          if (!clientId || ws.delegateJob) {
            ws.send(JSON.stringify({ type: 'error', message: 'Register as a primary session to read receipts' }));
            return;
          }
          const pending = jobStore.pending(clientId).map(job => ({
            jobId: job.jobId,
            status: job.status,
            from: job.from,
            requestedAt: job.requestedAt,
            completedAt: job.completedAt,
            exitCode: job.exitCode,
            summary: job.summary,
            // Server-attested: what this delegate actually sent, and whether
            // it was delivered live or queued.
            outbound: job.outbound
          }));
          ws.send(JSON.stringify({ type: 'receipts', receipts: pending }));
          break;
        }

        case 'ack_receipts': {
          // The owning session states it has reported these to the human.
          if (!clientId || ws.delegateJob) {
            ws.send(JSON.stringify({ type: 'error', message: 'Register as a primary session to acknowledge receipts' }));
            return;
          }
          const requested = Array.isArray(msg.jobIds) ? msg.jobIds : [];
          // Only this owner's jobs may be marked, whatever ids were sent.
          const own = requested.filter(id => {
            const job = jobStore.get(id);
            return job && job.owner === clientId;
          });
          const marked = jobStore.markReported(own, msg.turnId);
          ws.send(JSON.stringify({ type: 'receipts_acked', jobIds: marked }));
          logger.info('receipts_reported', { clientId, count: marked.length, turnId: msg.turnId || null });
          break;
        }

        case 'ack_enrollment': {
          // Phase 2 of enrollment: the client proves it durably holds the
          // capability we minted. Only then does the label leave its
          // migration window (re-check #4) — an enrollment whose plaintext
          // was lost must stay reclaimable rather than becoming a label
          // nobody can ever claim again.
          if (!clientId || msg.clientId !== clientId) {
            ws.send(JSON.stringify({ type: 'error', message: 'Enrollment acknowledgement must match this identity' }));
            return;
          }
          if (capabilities.verifyOwner(clientId, msg.ownerSecret)) {
            logger.info('enrollment_acknowledged', { clientId });
          } else {
            logger.warn('enrollment_ack_invalid', { clientId });
          }
          break;
        }

        case 'get_history':
          if (!clientId) {
            ws.send(JSON.stringify({ type: 'error', message: 'Register before reading history' }));
            return;
          }
          // A delegate reads with its base label's visibility — that is the
          // entire reason it exists (mail is addressed to the base) — but
          // least authority applies: it sees only its assigned inbound
          // message onward, never the label's full seven-day mailbox.
          const result = messageStore.query({
            requester: ws.delegateOf || clientId,
            floorId: ws.delegateJob ? ws.delegateJob.messageId : undefined,
            count: msg.count,
            from: msg.from,
            to: msg.to,
            after: msg.after
          });
          ws.send(JSON.stringify({
            type: 'history',
            messages: result.messages,
            cursor: result.cursor,
            unknownCursor: result.unknownCursor
          }));
          break;

        case 'clear_history':
          if (!clientId) {
            ws.send(JSON.stringify({ type: 'error', message: 'Register before clearing history' }));
            return;
          }
          if (ws.delegateJob) {
            ws.send(JSON.stringify({ type: 'error', message: 'Delegates may not clear history' }));
            return;
          }
          const clearedCount = messageStore.clearCache();
          ws.send(JSON.stringify({
            type: 'history_cleared',
            cleared: clearedCount,
            durableHistoryPreserved: true
          }));
          logger.info('history_cache_cleared', { clientId, cleared: clearedCount });
          break;

        case 'purge_history':
          if (ws.delegateJob || !clientId || !ADMIN_CLIENT_IDS.has(clientId)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Durable history purge is not authorized' }));
            logger.warn('history_purge_rejected', { clientId: clientId || 'unregistered' });
            return;
          }
          const purgeResult = messageStore.purge();
          ws.send(JSON.stringify({ type: 'history_purged', ...purgeResult }));
          logger.warn('history_purged', { clientId, ...purgeResult });
          break;

        case 'get_peers':
          if (!clientId && !isLoopback(req.socket.remoteAddress)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Register before listing peers' }));
            return;
          }
          // Return list of connected peers
          ws.send(JSON.stringify({
            type: 'peers',
            peers: Array.from(clients.keys()),
            self: clientId
          }));
          break;

        case 'get_sessions':
          if (!clientId && !isLoopback(req.socket.remoteAddress)) {
            // Session metadata (pid/cwd/host) must not be readable by an
            // unregistered socket from the NETWORK (re-check #6). Local
            // tooling (sessions/status.js) may still query directly.
            ws.send(JSON.stringify({ type: 'error', message: 'Register before listing sessions' }));
            return;
          }
          if (ws.delegateJob) {
            // Session enumeration exposes every peer's pid/cwd; a job
            // delegate has no need for it (least authority).
            ws.send(JSON.stringify({ type: 'error', message: 'Delegates may not enumerate sessions' }));
            return;
          }
          // Return every currently-connected session with its metadata, so any
          // peer can render the whole cluster (not just its local registry.json).
          const sessions = {};
          for (const id of clients.keys()) {
            sessions[id] = clientMeta.get(id) || {};
          }
          ws.send(JSON.stringify({
            type: 'sessions',
            sessions,
            self: clientId
          }));
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;

        default:
          logger.warn('unknown_message_type', { clientId, messageType: msg.type });
      }
    } catch (err) {
      logger.error('message_processing_failed', { clientId, error: err.message });
      ws.send(JSON.stringify({
        type: 'error',
        message: err.message
      }));
    }
  });

  ws.on('close', () => {
    if (ws.delegateLease) {
      clearTimeout(ws.delegateLease);
      ws.delegateLease = null;
    }
    removeWatcher(ws);
    if (clientId) {
      const wasLiveClient = clients.get(clientId) === ws;
      if (clients.get(clientId) === ws) {
        clients.delete(clientId);
        clientMeta.delete(clientId);
      }
      logger.info('client_disconnected', { clientId });

      if (wasLiveClient) {
        // Notify others
        broadcast({
          type: 'peer_left',
          clientId,
          peers: Array.from(clients.keys())
        });
      }
    }
  });

  ws.on('error', (err) => {
    logger.error('websocket_error', { clientId, error: err.message });
  });
});

// Detect connections whose underlying socket died without a clean close
// (crash, network drop, sleep/wake) -- otherwise a stale entry lingers in
// `clients` forever, permanently rejecting the real client's reconnects as
// "duplicate client ID".
const HEARTBEAT_INTERVAL_MS = 30000;
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      logger.warn('unresponsive_connection_terminated', { clientId: ws.clientId || null });
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeatInterval));
const retentionInterval = setInterval(() => {
  messageStore.prune();
  logger.prune();
}, 60 * 60 * 1000);
wss.on('close', () => clearInterval(retentionInterval));

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * The pid that actually owns the other end of a loopback TCP connection,
 * read from the kernel's socket table.
 *
 * This is the difference between defense and theater: every previous version
 * of the delegate binding trusted `meta.pid`, which a thief simply quotes
 * from the wake's own process tree. The peer's real pid cannot be asserted —
 * only observed.
 */
// Resolved by absolute path, never via PATH: the launchd plist ships a
// minimal PATH without /usr/sbin, which made every peer lookup fail — and
// because the binding fails closed, every delegate wake was refused.
const LSOF_PATH = ['/usr/sbin/lsof', '/usr/bin/lsof', '/opt/homebrew/bin/lsof', '/usr/local/bin/lsof']
  .find(candidate => { try { require('fs').accessSync(candidate, require('fs').constants.X_OK); return true; } catch { return false; } })
  || 'lsof';

function peerPidForPort(port) {
  if (!port) return Promise.resolve(null);
  return new Promise(resolve => {
    execFile(
      LSOF_PATH,
      ['-nP', '-a', `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-Fpn'],
      { encoding: 'utf8', timeout: 3000 },
      (err, stdout) => resolve(err ? null : parsePeerPid(stdout, port))
    );
  });
}

function parsePeerPid(out, port) {
  try {
    let pid = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) {
        pid = Number(line.slice(1)) || null;
      } else if (line.startsWith('n') && pid) {
        // "n<local>-><remote>": the peer is the socket whose LOCAL side is
        // the port we saw as remote.
        const [local] = line.slice(1).split('->');
        if (local && local.endsWith(`:${port}`)) return pid;
      }
    }
  } catch {
    return null;
  }
  return null;
}

// Is `pid` inside the process tree rooted at `ancestorPid`? Used to bind a
// delegate registration to the wake the server itself spawned, so a stolen
// bearer token is not sufficient on its own.
function isDescendantOf(pid, ancestorPid) {
  if (!pid || !ancestorPid) return false;
  let current = Number(pid);
  for (let depth = 0; depth < 12; depth += 1) {
    if (current === Number(ancestorPid)) return true;
    if (!current || current <= 1) return false;
    try {
      const parent = execFileSync('ps', ['-o', 'ppid=', '-p', String(current)], {
        encoding: 'utf8',
        timeout: 2000
      }).trim();
      current = Number(parent);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Decide a contest for a label whose socket is currently open.
 *
 * The old rules trusted the CLAIMANT's asserted pid ("same pid, so it must be
 * me reconnecting"), which is forgeable — the exact error that made pid
 * anchoring bypassable (review finding #2 and its re-checks). The server now
 * relies only on what IT can observe:
 *
 *   - the holder answers a liveness probe  -> the label is in use: REJECT,
 *     no matter what the claimant asserts or presents.
 *   - the holder does not answer           -> the socket is a corpse: the
 *     claimant may take it, provided it passed the capability gate.
 *
 * A pid is recorded for diagnostics only and never decides the outcome.
 */
function probeHolder(holder, { attempts = 3, perAttemptMs = 3000 } = {}) {
  return new Promise(resolve => {
    if (!holder || holder.readyState !== 1) return resolve(false);
    let settled = false;
    let timer = null;
    let remaining = attempts;
    const done = alive => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      holder.off('pong', onPong);
      resolve(alive);
    };
    const onPong = () => done(true);
    holder.on('pong', onPong);
    // Several probes over ~9s, not one over 2s: an event-loop stall or a
    // sleep/wake pause must never be mistaken for a dead owner and cost a
    // live session its label (re-check #7).
    const attempt = () => {
      if (settled) return;
      if (remaining <= 0 || holder.readyState !== 1) return done(false);
      remaining -= 1;
      try {
        holder.ping();
      } catch {
        return done(false);
      }
      timer = setTimeout(attempt, perAttemptMs);
      if (typeof timer.unref === 'function') timer.unref();
    };
    attempt();
  });
}

function broadcast(message, excludeClient = null) {
  const data = JSON.stringify(message);
  clients.forEach((ws, id) => {
    if (id !== excludeClient && ws.readyState === 1) {
      ws.send(data);
    }
  });
}

function notifyWatchers(to, at, from) {
  const targets = to === 'all' ? Array.from(watchers.keys()) : [to];
  for (const target of targets) {
    // A broadcast must not wake the sender's own watcher — an agent pinging
    // itself awake over its own outbound mail would loop forever.
    if (from && target === from) continue;
    const subscribers = watchers.get(target);
    if (!subscribers) continue;
    const ping = JSON.stringify({ type: 'new_message', for: target, at });
    for (const watcher of subscribers) {
      if (watcher.readyState === 1) watcher.send(ping);
    }
  }
}

function removeWatcher(ws) {
  if (!ws.watchTarget) return;
  const subscribers = watchers.get(ws.watchTarget);
  if (subscribers) {
    subscribers.delete(ws);
    if (subscribers.size === 0) watchers.delete(ws.watchTarget);
  }
  ws.watchTarget = null;
}

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('server_stopping', { signal: 'SIGINT' });
  wss.close(() => {
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  logger.info('server_stopping', { signal: 'SIGTERM' });
  wss.close(() => process.exit(0));
});
