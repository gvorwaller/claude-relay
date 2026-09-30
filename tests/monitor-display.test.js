'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Exercise the actual browser renderers with a minimal DOM; all displayed
// strings must use textContent, including untrusted directory names/reasons.
class Element {
  constructor() { this.children = []; this.dataset = {}; this.listeners = {}; this.value = ''; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return [this.text || '', ...this.children.map(child => child.textContent)].join(' '); }
  showModal() {}
}

test('monitor renders terminal timing, failure reason, directory and active timing distinctly', async () => {
  const elements = new Map();
  const job = { jobId: 'wake_test', owner: 'CODEX20', requester: 'GROK', status: 'failed',
    completedAgeMs: 120000, runAgeMs: 330, lastActivityAgeMs: 120000,
    currentCwdBasename: 'birds', error: { reason: 'Codex refused to start outside Git.' } };
  const context = vm.createContext({
    document: {
      getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
      createElement() { return new Element(); }
    },
    EventSource: class { addEventListener() {} },
    fetch: async url => url.includes('/jobs/') ? { ok: true, json: async () => job } : new Promise(() => {}),
    window: { location: { replace() {} } },
    job
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../monitor-web/public/app.js'), 'utf8'), context);
  const terminal = vm.runInContext('jobCard(job).textContent', context);
  assert.match(terminal, /ended 2m ago · duration <1s/);
  assert.match(terminal, /Current working directory: birds/);
  assert.match(terminal, /Codex refused/);
  assert.doesNotMatch(terminal, /running|yet/);
  assert.match(vm.runInContext('jobCard({...job,status:"running",error:null}).textContent', context), /running <1s/);
  assert.match(vm.runInContext('jobCard({...job,status:"spawned",error:null}).textContent', context), /starting <1s/);
  vm.runInContext('renderIdentities([{identity:"CODEX20",live:true,cwdBasename:"birds"}])', context);
  assert.match(elements.get('identities').textContent, /Working directory: birds/);
  await vm.runInContext('showDetail("wake_test")', context);
  assert.match(elements.get('detail-body').textContent, /Failure Codex refused/);
});

test('monitor preserves work-card nodes across snapshot refreshes so clicks survive', () => {
  const elements = new Map();
  const context = vm.createContext({
    document: {
      getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
      createElement() { return new Element(); }
    },
    EventSource: class { addEventListener() {} },
    fetch: async () => new Promise(() => {}),
    window: { location: { replace() {} } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../monitor-web/public/app.js'), 'utf8'), context);
  vm.runInContext(`
    const testContainer = document.getElementById('test-jobs');
    const testCount = document.getElementById('test-count');
    const firstJob = {
      jobId: 'wake_stable', owner: 'CODEX1', requester: 'OWNER', status: 'completed',
      completedAgeMs: 1000, runAgeMs: 2000, lastActivityAgeMs: 1000, processAlive: false
    };
    renderJobs(testContainer, testCount, [firstJob], 'Empty');
    globalThis.firstCard = testContainer.children[0];
    renderJobs(testContainer, testCount, [{ ...firstJob, completedAgeMs: 6000 }], 'Empty');
    globalThis.secondCard = testContainer.children[0];
  `, context);
  assert.strictEqual(context.firstCard, context.secondCard);
  assert.match(context.secondCard.textContent, /ended 6s ago/);
});
