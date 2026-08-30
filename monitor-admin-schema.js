'use strict';

const ADMIN_ACTIONS = Object.freeze([
  'restart_relay', 'cleanup_activity', 'repair_owner_credential',
  'remove_identity', 'cleanup_messages'
]);
const ADMIN_ACTION_SET = new Set(ADMIN_ACTIONS);
const CLIENT_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const GATE_NAMES = Object.freeze({
  restart_relay: 'MONITOR_ADMIN_RESTART_ENABLED',
  cleanup_activity: 'MONITOR_ADMIN_ACTIVITY_CLEANUP_ENABLED',
  repair_owner_credential: 'MONITOR_ADMIN_CREDENTIAL_REPAIR_ENABLED',
  remove_identity: 'MONITOR_ADMIN_IDENTITY_REMOVAL_ENABLED',
  cleanup_messages: 'MONITOR_ADMIN_MESSAGE_CLEANUP_ENABLED'
});

function actionGates(source = process.env) {
  const enabled = {};
  for (const action of ADMIN_ACTIONS) enabled[action] = source[GATE_NAMES[action]] === '1';
  enabled.cleanup_activity_all = source.MONITOR_ADMIN_ACTIVITY_CLEANUP_ALL_ENABLED === '1';
  enabled.cleanup_messages_all = source.MONITOR_ADMIN_MESSAGE_CLEANUP_ALL_ENABLED === '1';
  return enabled;
}

function enabledActions(gates) {
  return ADMIN_ACTIONS.filter(action => gates[action]).sort();
}

function exactObject(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function exactIdentity(value) {
  return typeof value === 'string' && value !== 'all' && CLIENT_ID.test(value);
}

function validateAdminTarget(action, target, gates = {}) {
  if (!ADMIN_ACTION_SET.has(action)) throw new Error('unknown_action');
  if (action === 'restart_relay') {
    if (!exactObject(target, [])) throw new Error('invalid_target');
  } else if (action === 'repair_owner_credential' || action === 'remove_identity') {
    if (!exactObject(target, ['identity']) || !exactIdentity(target.identity)) throw new Error('invalid_target');
  } else if (action === 'cleanup_activity') {
    if (exactObject(target, ['scope']) && target.scope === 'all') {
      if (!gates.cleanup_activity_all) throw new Error('scope_disabled');
    } else if (!exactObject(target, ['scope', 'identity']) || target.scope !== 'owner' || !exactIdentity(target.identity)) {
      throw new Error('invalid_target');
    }
  } else if (action === 'cleanup_messages') {
    if (exactObject(target, ['scope']) && target.scope === 'all') {
      if (!gates.cleanup_messages_all) throw new Error('scope_disabled');
    } else if (!exactObject(target, ['scope', 'identity']) || target.scope !== 'identity' || !exactIdentity(target.identity)) {
      throw new Error('invalid_target');
    }
  }
  return target;
}

module.exports = { ADMIN_ACTIONS, GATE_NAMES, actionGates, enabledActions, exactIdentity, validateAdminTarget };
