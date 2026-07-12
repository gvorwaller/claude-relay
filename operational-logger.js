const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;

class OperationalLogger {
  constructor(options = {}) {
    this.logDir = options.logDir || path.join(__dirname, 'logs');
    this.retentionDays = options.retentionDays || 7;
    this.maxTotalBytes = options.maxTotalBytes || 50 * 1024 * 1024;
    this.maxFileBytes = options.maxFileBytes || 10 * 1024 * 1024;
    this.now = options.now || (() => new Date());
    this.lastPruneAt = 0;
    fs.mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
    this.prune();
  }

  info(event, fields = {}) { this.write('info', event, fields); }
  warn(event, fields = {}) { this.write('warn', event, fields); }
  error(event, fields = {}) { this.write('error', event, fields); }

  write(level, event, fields) {
    const record = { timestamp: this.now().toISOString(), level, event, ...fields };
    const line = `${JSON.stringify(record)}\n`;
    const file = this.currentFile(Buffer.byteLength(line));
    fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(file, 0o600);
    if (Date.now() - this.lastPruneAt >= 60 * 60 * 1000) this.prune();
  }

  currentFile(nextBytes) {
    const day = this.now().toISOString().slice(0, 10);
    let segment = 0;
    while (true) {
      const suffix = segment === 0 ? '' : `-${segment}`;
      const file = path.join(this.logDir, `operations-${day}${suffix}.jsonl`);
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (size + nextBytes <= this.maxFileBytes) return file;
      segment += 1;
    }
  }

  prune() {
    this.lastPruneAt = Date.now();
    const cutoff = this.now().getTime() - this.retentionDays * DAY_MS;
    let files = this.files();
    for (const file of files) {
      if (file.mtimeMs < cutoff) fs.unlinkSync(file.path);
    }
    files = this.files();
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (total <= this.maxTotalBytes) break;
      fs.unlinkSync(file.path);
      total -= file.size;
    }
  }

  files() {
    if (!fs.existsSync(this.logDir)) return [];
    return fs.readdirSync(this.logDir)
      .filter(name => /^operations-\d{4}-\d{2}-\d{2}(?:-\d+)?\.jsonl$/.test(name))
      .map(name => {
        const filePath = path.join(this.logDir, name);
        const stat = fs.statSync(filePath);
        return { path: filePath, size: stat.size, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
  }
}

module.exports = { OperationalLogger };
