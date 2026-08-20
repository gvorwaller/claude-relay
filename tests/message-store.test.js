const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MessageStore } = require('../message-store');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-messages-'));
}

test('journal survives restart and enforces direct-message visibility', () => {
  const dataDir = tempDir();
  const first = new MessageStore({ dataDir });
  first.initialize();
  first.append({ from: 'A', to: 'B', content: 'private', delivered: true });
  first.append({ from: 'A', to: 'all', content: 'broadcast', delivered: true });

  const restarted = new MessageStore({ dataDir });
  restarted.initialize();
  assert.deepEqual(restarted.query({ requester: 'B', count: 10 }).messages.map(m => m.content), ['private', 'broadcast']);
  assert.deepEqual(restarted.query({ requester: 'C', count: 10 }).messages.map(m => m.content), ['broadcast']);
  assert.equal(fs.statSync(restarted.journalFiles()[0].path).mode & 0o777, 0o600);
});

test('filters before limiting and supports ID cursors', () => {
  const store = new MessageStore({ dataDir: tempDir(), maxQueryCount: 100 });
  store.initialize();
  const first = store.append({ from: 'CC2', to: 'CODEX2', content: 'one' });
  for (let i = 0; i < 20; i += 1) store.append({ from: 'noise', to: 'CODEX2', content: `noise-${i}` });
  store.append({ from: 'CC2', to: 'CODEX2', content: 'two' });

  assert.deepEqual(
    store.query({ requester: 'CODEX2', from: 'CC2', count: 2 }).messages.map(m => m.content),
    ['one', 'two']
  );
  assert.deepEqual(
    store.query({ requester: 'CODEX2', after: first.id, count: 100 }).messages.map(m => m.content),
    [...Array.from({ length: 20 }, (_, i) => `noise-${i}`), 'two']
  );
});

test('cache clear preserves durable history and purge removes it', () => {
  const store = new MessageStore({ dataDir: tempDir() });
  store.initialize();
  store.append({ from: 'A', to: 'B', content: 'kept' });
  assert.equal(store.clearCache(), 1);
  assert.equal(store.query({ requester: 'B' }).messages.length, 1);
  const result = store.purge();
  assert.equal(result.filesDeleted, 1);
  assert.equal(store.query({ requester: 'B' }).messages.length, 0);
});

test('identity-scoped purge is preview-bound and atomically preserves unrelated messages', () => {
  const store = new MessageStore({ dataDir: tempDir() });
  store.initialize();
  store.append({ from: 'CC1', to: 'CODEX1', content: 'remove one' });
  store.append({ from: 'CODEX1', to: 'CC2', content: 'remove two' });
  store.append({ from: 'CC3', to: 'CODEX3', content: 'keep' });
  const preview = store.previewPurge('CODEX1');
  assert.equal(preview.count, 2);
  assert.equal(store.purgePreviewed('CODEX1', 'wrong').confirmed, false);
  const result = store.purgePreviewed('CODEX1', preview.confirmation);
  assert.equal(result.purged, 2);
  assert.deepEqual(store.readAll().map(message => message.content), ['keep']);
  assert.deepEqual(store.query({ requester: 'CODEX3' }).messages.map(message => message.content), ['keep']);
});

test('prunes files older than seven UTC days and tolerates a corrupt final line', () => {
  const dataDir = tempDir();
  const now = new Date('2026-07-12T12:00:00.000Z');
  fs.writeFileSync(path.join(dataDir, '2026-07-05.jsonl'), '{"old":true}\n');
  fs.writeFileSync(path.join(dataDir, '2026-07-06.jsonl'), `${JSON.stringify({ id: 'kept', timestamp: '2026-07-06T00:00:00.000Z', from: 'A', to: 'B', content: 'kept' })}\n{"partial"`);
  const store = new MessageStore({ dataDir, retentionDays: 7, now: () => now });
  store.initialize();
  assert.equal(fs.existsSync(path.join(dataDir, '2026-07-05.jsonl')), false);
  assert.equal(store.query({ requester: 'B' }).messages[0].content, 'kept');
});

test('bounds the memory cache by count', () => {
  const store = new MessageStore({ dataDir: tempDir(), maxCacheMessages: 2 });
  store.initialize();
  store.append({ from: 'A', to: 'B', content: 'one' });
  store.append({ from: 'A', to: 'B', content: 'two' });
  store.append({ from: 'A', to: 'B', content: 'three' });
  assert.deepEqual(store.cache.map(m => m.content), ['two', 'three']);
});

test('unknown opaque cursor returns nothing and flags it instead of replaying history', () => {
  const store = new MessageStore({ dataDir: tempDir() });
  store.initialize();
  store.append({ from: 'A', to: 'B', content: 'one' });
  const second = store.append({ from: 'A', to: 'B', content: 'two' });

  // Pruned/mistyped/foreign UUID: nothing replayed, caller told to resync.
  const unknown = store.query({ requester: 'B', after: 'ffffffff-0000-0000-0000-000000000000' });
  assert.deepEqual(unknown.messages, []);
  assert.equal(unknown.unknownCursor, true);

  // Known id and ISO timestamps keep their exact prior semantics.
  const afterFirst = store.query({ requester: 'B', after: second.id });
  assert.deepEqual(afterFirst.messages, []);
  assert.equal(afterFirst.unknownCursor, undefined);
  const afterEpoch = store.query({ requester: 'B', after: '2000-01-01T00:00:00.000Z' });
  assert.deepEqual(afterEpoch.messages.map(m => m.content), ['one', 'two']);
  assert.equal(afterEpoch.unknownCursor, undefined);
});

test('opaque cursor is resolved before sender filtering for request-reply waits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-store-filter-cursor-'));
  const store = new MessageStore({ dataDir: root });
  store.initialize();
  const outbound = store.append({ from: 'CODEX', to: 'M2', content: 'request' });
  store.append({ from: 'M2', to: 'CODEX', content: 'ACK' });

  const result = store.query({ requester: 'CODEX', from: 'M2', after: outbound.id });
  assert.deepEqual(result.messages.map(message => message.content), ['ACK']);
  assert.equal(result.unknownCursor, undefined);
});

test('inbound-only mailbox reads exclude own sends and retain broadcasts', () => {
  const store = new MessageStore({ dataDir: tempDir() });
  store.initialize();
  const outbound = store.append({ from: 'CC1', to: 'GROK', content: 'review this' });
  store.append({ from: 'GROK', to: 'CC1', content: 'review complete' });
  store.append({ from: 'CC2', to: 'all', content: 'shared notice' });
  store.append({ from: 'CC1', to: 'all', content: 'my own broadcast' });

  const result = store.query({ requester: 'CC1', after: outbound.id, inboundOnly: true });
  assert.deepEqual(result.messages.map(message => message.content), ['review complete', 'shared notice']);
  assert.equal(result.unknownCursor, undefined);

  // Explicit audit reads keep the prior whole-conversation behavior.
  assert.deepEqual(
    store.query({ requester: 'CC1', after: outbound.id }).messages.map(message => message.content),
    ['review complete', 'shared notice', 'my own broadcast']
  );
});

test('delegate floor slices by durable order, not wall clock', () => {
  const store = new MessageStore({ dataDir: tempDir(), now: () => new Date('2026-08-06T00:00:00.000Z') });
  store.initialize();
  // Three messages sharing one millisecond: a timestamp-based floor would
  // leak the earlier ones.
  store.append({ from: 'A', to: 'B', content: 'before' });
  const floor = store.append({ from: 'A', to: 'B', content: 'floor' });
  store.append({ from: 'A', to: 'B', content: 'after' });

  const scoped = store.query({ requester: 'B', floorId: floor.id, count: 10 });
  assert.deepEqual(scoped.messages.map(m => m.content), ['floor', 'after']);

  // An unknown floor yields nothing rather than the whole mailbox.
  const unknown = store.query({ requester: 'B', floorId: 'nope', count: 10 });
  assert.deepEqual(unknown.messages, []);
  assert.equal(unknown.unknownCursor, true);
});
