const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rolloutIdFromPath(file) {
  const match = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match ? match[1] : null;
}

function rolloutSessionIds(file, maxBytes = 2 * 1024 * 1024) {
  const ids = new Set();
  const pathId = rolloutIdFromPath(file);
  if (pathId) ids.add(pathId);

  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = Math.min(fs.fstatSync(fd).size, maxBytes);
    const buffer = Buffer.alloc(size);
    const bytes = fs.readSync(fd, buffer, 0, size, 0);
    for (const line of buffer.subarray(0, bytes).toString('utf8').split('\n')) {
      if (!line.includes('session_meta')) continue;
      try {
        const record = JSON.parse(line);
        if (record?.type !== 'session_meta') continue;
        for (const candidate of [record.payload?.id, record.payload?.session_id]) {
          if (typeof candidate === 'string' && UUID_PATTERN.test(candidate)) ids.add(candidate);
        }
      } catch {
        // A partial final line is expected while the active rollout is growing.
      }
    }
  } catch {
    return ids;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  return ids;
}

function openRolloutFiles(pid, run = execFileSync) {
  try {
    const output = run('lsof', ['-p', String(Number(pid))], {
      encoding: 'utf8',
      timeout: 5000
    });
    return [...new Set(output.match(/\/[^\s]*rollout-[^\s]*\.jsonl/g) || [])];
  } catch {
    return [];
  }
}

function detectCodexRolloutContext(pid, options = {}) {
  const files = options.files || openRolloutFiles(pid, options.execFileSync || execFileSync);
  const candidates = files.flatMap(file => {
    const currentId = rolloutIdFromPath(file);
    if (!currentId) return [];
    try {
      return [{
        file,
        currentId,
        mtimeMs: fs.statSync(file).mtimeMs,
        lineageIds: rolloutSessionIds(file, options.maxBytes)
      }];
    } catch {
      return [];
    }
  });
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file));
  const active = candidates[0];
  return {
    currentId: active.currentId,
    lineageIds: active.lineageIds,
    rolloutFile: active.file,
    openRolloutFiles: candidates.map(value => value.file)
  };
}

module.exports = {
  detectCodexRolloutContext,
  openRolloutFiles,
  rolloutIdFromPath,
  rolloutSessionIds
};
