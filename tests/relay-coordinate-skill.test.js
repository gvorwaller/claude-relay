const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('relay-coordinate skill relies on hook-driven turns instead of active waiting', () => {
  const text = fs.readFileSync(
    path.join(__dirname, '..', 'skills', 'relay-coordinate', 'SKILL.md'),
    'utf8'
  );
  assert.match(text, /RELAY_DONE/);
  assert.match(text, /exact peer ID/);
  assert.match(text, /end the turn/i);
  assert.match(text, /wake/i);
  assert.match(text, /Never hold a model turn open, poll, re-arm a timeout/i);
  assert.doesNotMatch(text, /relay_wait/i);
});
