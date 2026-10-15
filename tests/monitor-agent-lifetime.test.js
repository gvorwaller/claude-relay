'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('agent stays alive between disconnected sockets and reconnects', () => {
  const script = `
    const {EventEmitter} = require('node:events');
    const {createMonitorAgent} = require('./scripts/relay-monitor-agent');
    let connections = 0;
    class Socket extends EventEmitter {
      constructor() { super(); connections++;
        if (connections === 2) { console.log('reconnected'); agent.stop(); }
        else setImmediate(() => this.emit('close'));
      }
      close() {}
    }
    const agent = createMonitorAgent({ url:'ws://localhost', allowInsecure:true,
      installationId:'test', secret:'test', WebSocket:Socket, logger:{warn(){}} });
    agent.start();
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'), encoding:'utf8', timeout:5000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reconnected/);
});
