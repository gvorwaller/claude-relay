const test = require('node:test');
const assert = require('node:assert/strict');
const { RelayWaiter } = require('../relay-waiter');

function harness() {
  let now = 1000;
  let timer;
  const responses = [];
  const logs = [];
  const waiter = new RelayWaiter({
    respond: (id, text) => responses.push({ id, text }),
    log: fields => logs.push(fields),
    now: () => now,
    setTimer: (fn, ms) => (timer = { fn, ms, cleared: false }),
    clearTimer: value => { value.cleared = true; }
  });
  return { waiter, responses, logs, get timer() { return timer; }, advance: ms => { now += ms; } };
}

const message = (id, from = 'CC2', timestamp = '2026-07-12T12:00:00.000Z') => ({
  type: 'message', id, from, to: 'CODEX', content: `work ${id}`, timestamp
});

test('durable history returns immediately with UUID cursor', () => {
  const h = harness();
  assert.equal(h.waiter.start({ requestId: 1, from: 'CC2' }), true);
  assert.equal(h.waiter.deliverHistory([message('m1')]), true);
  assert.match(h.responses[0].text, /Cursor: m1/);
  assert.equal(h.timer.cleared, true);
});

test('pushed message resolves an active wait and is logged without content', () => {
  const h = harness();
  h.waiter.start({ requestId: 2, from: 'CC2' });
  h.advance(25);
  h.waiter.deliver(message('m2'), 'push');
  assert.equal(h.logs[0].completionReason, 'message');
  assert.equal(h.logs[0].messageId, 'm2');
  assert.equal(Object.hasOwn(h.logs[0], 'content'), false);
});

test('sender filter leaves nonmatching push unsettled', () => {
  const h = harness();
  h.waiter.start({ requestId: 3, from: 'CC2' });
  assert.equal(h.waiter.deliver(message('m3', 'CC3'), 'push'), false);
  assert.ok(h.waiter.pending);
});

test('after prevents history replay and ISO cursors filter push', () => {
  const h = harness();
  h.waiter.start({ requestId: 4, after: 'm4' });
  assert.equal(h.waiter.deliverHistory([message('m4')]), false);
  assert.ok(h.waiter.pending);
  h.waiter.finish('cancel');
  h.waiter.start({ requestId: 5, after: '2026-07-12T12:00:00.000Z' });
  assert.equal(h.waiter.deliver(message('old', 'CC2', '2026-07-12T11:59:59.000Z')), false);
});

test('push/history race and reconnect replay return a message once', () => {
  const h = harness();
  h.waiter.start({ requestId: 6 });
  assert.equal(h.waiter.deliver(message('m6'), 'push'), true);
  assert.equal(h.waiter.deliverHistory([message('m6')]), false);
  h.waiter.start({ requestId: 7 });
  assert.equal(h.waiter.deliver(message('m6'), 'push'), false);
  assert.equal(h.responses.length, 1);
});

test('timeout is normal, preserves cursor, and clears waiter', () => {
  const h = harness();
  h.waiter.start({ requestId: 8, after: 'm7', timeoutSeconds: 2 });
  h.advance(2000);
  h.timer.fn();
  assert.match(h.responses[0].text, /No matching relay message/);
  assert.match(h.responses[0].text, /Cursor: m7/);
  assert.equal(h.waiter.pending, null);
});

test('second simultaneous wait is rejected without replacing first', () => {
  const h = harness();
  assert.equal(h.waiter.start({ requestId: 9 }), true);
  assert.equal(h.waiter.start({ requestId: 10 }), false);
  assert.equal(h.waiter.pending.requestId, 9);
});

test('disconnect and cancellation settle and clear timers', () => {
  const h = harness();
  h.waiter.start({ requestId: 11, after: 'm10' });
  h.waiter.finish('disconnect');
  assert.match(h.responses[0].text, /disconnected/);
  assert.equal(h.timer.cleared, true);
  h.waiter.start({ requestId: 12 });
  h.waiter.finish('cancel');
  assert.match(h.responses[1].text, /cancelled/);
});
