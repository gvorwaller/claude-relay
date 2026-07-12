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
