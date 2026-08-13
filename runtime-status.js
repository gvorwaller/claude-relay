'use strict';

const fs = require('fs');
const path = require('path');

const STATUS_VERSION = 1;

class RuntimeStatus {
  constructor(options = {}) {
    this.filePath = options.filePath || path.join(__dirname, 'data', 'runtime-status.json');
    this.now = options.now || (() => new Date());
    this.state = null;
  }

  initialize({ host, port, checks = {}, metrics = {}, alerts = [] }) {
    const timestamp = this.now().toISOString();
    this.state = {
      version: STATUS_VERSION,
      pid: process.pid,
      startedAt: timestamp,
      updatedAt: timestamp,
      host,
      port,
      checks,
      metrics,
      alerts
    };
    this.persist();
    return this.state;
  }

  update({ checks, metrics, alerts } = {}) {
    if (!this.state) throw new Error('Runtime status is not initialized');
    if (checks) this.state.checks = { ...this.state.checks, ...checks };
    if (metrics) this.state.metrics = { ...this.state.metrics, ...metrics };
    if (alerts) this.state.alerts = alerts;
    this.state.updatedAt = this.now().toISOString();
    this.persist();
    return this.state;
  }

  persist() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
  }
}

function readRuntimeStatus(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!value || value.version !== STATUS_VERSION || !Number.isInteger(value.pid)) return null;
    if (!value.checks || typeof value.checks !== 'object') return null;
    if (!Array.isArray(value.alerts)) return null;
    return value;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function assessRuntimeStatus(status, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const pidAlive = options.pidAlive || processAlive;
  const maxAgeMs = options.maxAgeMs || 2 * 60 * 60 * 1000;
  const results = [];
  const push = (level, code, text) => results.push({ level, code, text });

  if (!status) {
    push('fail', 'status_missing', 'Runtime status is missing or invalid');
    return { ok: false, results };
  }
  if (!pidAlive(status.pid)) push('fail', 'daemon_not_running', 'Recorded relay daemon is not running');
  else push('pass', 'daemon_running', `Relay daemon is running (pid ${status.pid})`);

  const age = now - Date.parse(status.updatedAt || '');
  if (!Number.isFinite(age) || age > maxAgeMs) push('fail', 'status_stale', 'Runtime status is stale');
  else push('pass', 'status_fresh', 'Runtime status is fresh');

  if (status.checks.listenerLoopback === true) push('pass', 'loopback', 'Relay listener is loopback-only');
  else push('fail', 'loopback', 'Relay listener is exposed beyond loopback');

  if (status.checks.ancestryBindingReady === true) {
    push('pass', 'ancestry', 'Delegate ancestry binding is operational');
  } else {
    push('fail', 'ancestry', 'Delegate ancestry binding is unavailable or disabled');
  }

  for (const name of ['messageStore', 'capabilityStore', 'jobStore']) {
    if (status.checks[name] === true) push('pass', name, `${name} is accessible`);
    else push('fail', name, `${name} is unavailable`);
  }

  if (status.checks.notifyConfig === true) push('pass', 'notify', 'Notify configuration is valid');
  else push('warn', 'notify', 'Notify configuration is absent or invalid');

  for (const alert of status.alerts) {
    if (alert && alert.code === 'job_store_at_capacity') {
      push('fail', alert.code, 'Delegate job store is at capacity with retained work');
    }
  }
  return { ok: !results.some(result => result.level === 'fail'), results };
}

module.exports = { RuntimeStatus, readRuntimeStatus, assessRuntimeStatus, processAlive };
