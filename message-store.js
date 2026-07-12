const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const DAY_MS = 24 * 60 * 60 * 1000;

class MessageStore {
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.join(__dirname, 'data', 'messages');
    this.retentionDays = options.retentionDays || 7;
    this.maxDiskBytes = options.maxDiskBytes || 100 * 1024 * 1024;
    this.maxCacheMessages = options.maxCacheMessages || 500;
    this.maxCacheBytes = options.maxCacheBytes || 10 * 1024 * 1024;
    this.maxQueryCount = options.maxQueryCount || 100;
    this.now = options.now || (() => new Date());
    this.cache = [];
    this.cacheBytes = 0;
    this.lastPruneAt = 0;
  }

  initialize() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dataDir, 0o700);
    this.prune();
    const messages = this.readAll();
    for (const message of messages.slice(-this.maxCacheMessages)) {
      this.addToCache(message);
    }
  }

  append(message) {
    const envelope = {
      ...message,
      id: message.id || randomUUID(),
      timestamp: message.timestamp || this.now().toISOString()
    };
    const line = `${JSON.stringify(envelope)}\n`;
    const file = this.fileForDate(new Date(envelope.timestamp));
    fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(file, 0o600);
    this.addToCache(envelope, Buffer.byteLength(line));
    if (Date.now() - this.lastPruneAt >= 60 * 60 * 1000) this.prune();
    return envelope;
  }

  query({ requester, count = 10, from, to, after } = {}) {
    if (!requester) return { messages: [], cursor: null };
    const limit = Math.max(1, Math.min(Number(count) || 10, this.maxQueryCount));
    const cachedResult = this.filterMessages(this.cache, { requester, from, to, after });
    const afterIsCovered = !after
      || this.cache.some(message => message.id === after)
      || (Number.isFinite(Date.parse(after))
        && this.cache.length > 0
        && Date.parse(after) >= Date.parse(this.cache[0].timestamp));
    let messages = cachedResult.length >= limit && afterIsCovered
      ? cachedResult
      : this.filterMessages(this.readAll(), { requester, from, to, after });

    messages = messages.slice(-limit);
    return {
      messages,
      cursor: messages.length ? messages[messages.length - 1].id : null
    };
  }

  filterMessages(source, { requester, from, to, after }) {
    let messages = source.filter(message => this.isVisibleTo(message, requester));

    if (from) messages = messages.filter(message => message.from === from);
    if (to) messages = messages.filter(message => message.to === to);
    if (after) {
      const index = messages.findIndex(message => message.id === after);
      if (index >= 0) {
        messages = messages.slice(index + 1);
      } else {
        const afterTime = Date.parse(after);
        if (Number.isFinite(afterTime)) {
          messages = messages.filter(message => Date.parse(message.timestamp) > afterTime);
        }
      }
    }
    return messages;
  }

  clearCache() {
    const cleared = this.cache.length;
    this.cache = [];
    this.cacheBytes = 0;
    return cleared;
  }

  purge() {
    let filesDeleted = 0;
    for (const file of this.journalFiles()) {
      fs.unlinkSync(file.path);
      filesDeleted += 1;
    }
    const cacheCleared = this.clearCache();
    return { filesDeleted, cacheCleared };
  }

  prune() {
    this.lastPruneAt = Date.now();
    const cutoff = this.startOfUTCDay(this.now()).getTime() - (this.retentionDays - 1) * DAY_MS;
    let files = this.journalFiles();
    for (const file of files) {
      if (file.date.getTime() < cutoff) fs.unlinkSync(file.path);
    }

    files = this.journalFiles();
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (total <= this.maxDiskBytes) break;
      fs.unlinkSync(file.path);
      total -= file.size;
    }
  }

  readAll() {
    const messages = [];
    for (const file of this.journalFiles()) {
      const lines = fs.readFileSync(file.path, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message && message.id && message.timestamp && message.from && message.to) {
            messages.push(message);
          }
        } catch {
          // A crash can leave one partial final line; retain the rest of the file.
        }
      }
    }
    return messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  isVisibleTo(message, requester) {
    return message.from === requester || message.to === requester || message.to === 'all';
  }

  addToCache(message, bytes = Buffer.byteLength(`${JSON.stringify(message)}\n`)) {
    this.cache.push(message);
    this.cacheBytes += bytes;
    while (this.cache.length > this.maxCacheMessages || this.cacheBytes > this.maxCacheBytes) {
      const removed = this.cache.shift();
      this.cacheBytes -= Buffer.byteLength(`${JSON.stringify(removed)}\n`);
    }
  }

  journalFiles() {
    if (!fs.existsSync(this.dataDir)) return [];
    return fs.readdirSync(this.dataDir)
      .map(name => {
        const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
        if (!match) return null;
        const filePath = path.join(this.dataDir, name);
        const stat = fs.statSync(filePath);
        return { path: filePath, date: new Date(`${match[1]}T00:00:00.000Z`), size: stat.size };
      })
      .filter(Boolean)
      .sort((a, b) => a.date - b.date);
  }

  fileForDate(date) {
    return path.join(this.dataDir, `${date.toISOString().slice(0, 10)}.jsonl`);
  }

  startOfUTCDay(date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  }
}

module.exports = { MessageStore };
