const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OperationalLogger } = require('../operational-logger');

test('writes structured metadata and segments bounded files', () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-logs-'));
  const logger = new OperationalLogger({
    logDir,
    maxFileBytes: 180,
    maxTotalBytes: 10_000,
    now: () => new Date('2026-07-12T12:00:00.000Z')
  });
  logger.info('message_recorded', { messageId: 'id-1', from: 'A', to: 'B', bytes: 500, delivered: true });
  logger.info('message_recorded', { messageId: 'id-2', from: 'A', to: 'B', bytes: 600, delivered: true });
  const files = logger.files();
  assert.equal(files.length, 2);
  const record = JSON.parse(fs.readFileSync(files[0].path, 'utf8').trim());
  assert.equal(record.event, 'message_recorded');
  assert.equal(record.content, undefined);
  assert.equal(fs.statSync(files[0].path).mode & 0o777, 0o600);
});
