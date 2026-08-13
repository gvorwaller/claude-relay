'use strict';

function runRetention({ messageStore, logger, capabilities, jobStore, refreshRuntimeStatus }) {
  messageStore.prune();
  logger.prune();
  const ownersRemoved = capabilities.pruneUnacknowledged();
  const jobs = jobStore.prune();
  if (refreshRuntimeStatus) refreshRuntimeStatus();
  return { ownersRemoved, jobs };
}

module.exports = { runRetention };
