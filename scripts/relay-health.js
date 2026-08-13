#!/usr/bin/env node
'use strict';

const path = require('path');
const { readRuntimeStatus, assessRuntimeStatus } = require('../runtime-status');

const args = process.argv.slice(2);
const value = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const dataRoot = value('--data-dir') || path.join(__dirname, '..', 'data');
const status = readRuntimeStatus(path.join(dataRoot, 'runtime-status.json'));
const assessment = assessRuntimeStatus(status);

console.log('claude-relay health');
for (const result of assessment.results) {
  console.log(`${result.level.toUpperCase().padEnd(4)}  ${result.text}`);
}
if (status && status.metrics) {
  const jobs = Number(status.metrics.jobsTotal) || 0;
  const retained = Number(status.metrics.jobsUnreported) || 0;
  const owners = Number(status.metrics.ownersPending) || 0;
  const labels = Array.isArray(status.metrics.ownersPendingLabels)
    ? status.metrics.ownersPendingLabels : [];
  console.log(`INFO  jobs=${jobs}, unreported=${retained}, named-owner-credentials-pending=${owners}`);
  if (labels.length) console.log(`INFO  pending named identities: ${labels.join(', ')}`);
}
process.exitCode = assessment.ok ? 0 : 1;
