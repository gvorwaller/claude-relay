'use strict';

const DEFAULT_TIMEOUT_SECONDS = 240;
const MAX_TIMEOUT_SECONDS = 300;

class RelayWaiter {
  constructor(options = {}) {
    this.respond = options.respond;
    this.log = options.log || (() => {});
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.now = options.now || (() => Date.now());
    this.recentLimit = options.recentLimit || 200;
    this.pending = null;
    this.recentIds = new Set();
  }

  start({ requestId, from, after, timeoutSeconds }) {
    if (this.pending) return false;
    const seconds = Math.max(1, Math.min(Number(timeoutSeconds) || DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS));
    const waiter = {
      requestId,
      from: from || null,
      after: after || null,
      timeoutSeconds: seconds,
      startedAt: this.now(),
      settled: false,
      timer: null
    };
    waiter.timer = this.setTimer(() => this.finish('timeout'), seconds * 1000);
    this.pending = waiter;
    return true;
  }

  accepts(message, source = 'push') {
    const waiter = this.pending;
    if (!waiter || waiter.settled || !message || message.type !== 'message' || !message.id) return false;
    if (waiter.from && message.from !== waiter.from) return false;
    if (this.recentIds.has(message.id)) return false;
    if (source === 'history' && waiter.after && !this.isAfter(message, waiter.after)) return false;
    if (source === 'push' && waiter.after && Number.isFinite(Date.parse(waiter.after)) &&
        Date.parse(message.timestamp) <= Date.parse(waiter.after)) return false;
    return true;
  }

  deliver(message, source = 'push') {
    if (!this.accepts(message, source)) return false;
    return this.finish('message', message);
  }

  deliverHistory(messages = []) {
    const match = messages.find(message => this.accepts(message, 'history'));
    return match ? this.finish('message', match) : false;
  }

  isAfter(message, cursor) {
    if (message.id === cursor) return false;
    const cursorTime = Date.parse(cursor);
    return !Number.isFinite(cursorTime) || Date.parse(message.timestamp) > cursorTime;
  }

  finish(reason, message) {
    const waiter = this.pending;
    if (!waiter || waiter.settled) return false;
    waiter.settled = true;
    this.clearTimer(waiter.timer);
    this.pending = null;

    if (message) this.remember(message.id);
    const cursor = message?.id || waiter.after || null;
    const durationMs = Math.max(0, this.now() - waiter.startedAt);
    this.log({
      messageId: message?.id || null,
      from: message?.from || waiter.from,
      waitDurationMs: durationMs,
      completionReason: reason
    });

    let text;
    if (reason === 'message') {
      text = `[${message.timestamp}] ${message.from}: ${message.content}\n\nCursor: ${message.id}`;
    } else if (reason === 'timeout') {
      text = `No matching relay message arrived within ${waiter.timeoutSeconds} seconds.\nCursor: ${cursor || 'none'}`;
    } else if (reason === 'disconnect') {
      text = `Relay disconnected while waiting. No cursor was advanced.\nCursor: ${cursor || 'none'}`;
    } else {
      text = `Relay wait was cancelled. No cursor was advanced.\nCursor: ${cursor || 'none'}`;
    }
    this.respond(waiter.requestId, text);
    return true;
  }

  remember(id) {
    this.recentIds.add(id);
    while (this.recentIds.size > this.recentLimit) {
      this.recentIds.delete(this.recentIds.values().next().value);
    }
  }
}

module.exports = { RelayWaiter, DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS };
