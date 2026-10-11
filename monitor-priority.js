'use strict';

// Separate a completed newest-listing checkpoint from an unfinished gap.
// New arrivals during catch-up are covered by the next gap, not forgotten.
function selectMercariHeadGap_(ids, state = {}, reachedBottom = false, limit = 10) {
  if (!Array.isArray(ids) || !ids.length) throw new Error('Mercari feed is empty; preserve saved state');
  const baseline = Array.isArray(state.baselineIds) ? state.baselineIds.map(String) : [];
  const snapshot = Array.isArray(state.snapshotIds) ? state.snapshotIds.map(String) : [];
  const headIds = ids.slice(0, limit);
  if (!baseline.length) {
    return { headIds, gapIds: [], state: { baselineIds: headIds, snapshotIds: [], afterId: '', offset: 0 } };
  }
  const activeSnapshot = snapshot.length ? snapshot : headIds;
  const boundary = ids.findIndex(id => baseline.includes(id));
  const anchor = state.afterId ? ids.indexOf(String(state.afterId)) : -1;
  const start = snapshot.length && anchor >= 0 ? anchor + 1 : limit;
  const end = boundary >= 0 ? boundary : ids.length;
  const gapIds = ids.slice(start, Math.min(start + limit, end));
  const finished = (boundary >= 0 && start + gapIds.length >= boundary) ||
    (reachedBottom && start + gapIds.length >= ids.length);
  return {
    headIds,
    gapIds,
    state: finished
      ? { baselineIds: activeSnapshot, snapshotIds: [], afterId: '', offset: 0 }
      : {
          baselineIds: baseline,
          snapshotIds: activeSnapshot,
          afterId: gapIds.length ? gapIds[gapIds.length - 1] : String(state.afterId || ''),
          // Keep loading farther if a saved anchor/boundary moved beyond the DOM.
          offset: Math.max(start + gapIds.length, Number(state.offset || 0) + (anchor < 0 ? limit : 0))
        }
  };
}

function selectConditionShardLegacy_(configs, env = process.env) {
  const count = Number(env.MONITOR_SHARD_COUNT || 1);
  const index = Number(env.MONITOR_SHARD_INDEX || 0);
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error('Invalid condition shard');
  }
  const hash = id => {
    let value = 2166136261;
    for (const c of String(id)) value = Math.imul(value ^ c.charCodeAt(0), 16777619) >>> 0;
    return value;
  };
  return (configs || []).filter(c => c && c.conditionId && hash(c.conditionId) % count === index).sort((a, b) =>
    Number(a.lastScannedAt || 0) - Number(b.lastScannedAt || 0) ||
    String(a.conditionId).localeCompare(String(b.conditionId))
  );
}

function selectDueConditionsLegacy_(configs, now = Date.now()) {
  const currentTime = Number(now);
  if (!Number.isFinite(currentTime)) {
    throw new Error('Invalid condition due timestamp');
  }
  return (configs || []).filter(config => {
    if (!config || !config.conditionId) return false;
    const configuredInterval = Number(config.intervalMinutes);
    const intervalMinutes =
      Number.isFinite(configuredInterval) && configuredInterval > 0
        ? configuredInterval
        : 5;
    const lastScannedAt = Number(config.lastScannedAt || 0);
    if (!Number.isFinite(lastScannedAt) || lastScannedAt <= 0) return true;
    return currentTime - lastScannedAt >= intervalMinutes * 60000;
  });
}

function monitoringIntervalMs_(config) {
  const configuredInterval = Number(config && config.intervalMinutes);
  const intervalMinutes =
    Number.isFinite(configuredInterval) &&
    configuredInterval > 0
      ? configuredInterval
      : 5;

  return intervalMinutes * 60000;
}

function successfulScanCompletedAt_(config) {
  const value = Number(config && config.lastScanCompletedAt || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function conditionOverdueMs_(config, now = Date.now()) {
  const currentTime = Number(now);
  if (!Number.isFinite(currentTime)) {
    throw new Error('Invalid condition overdue timestamp');
  }

  const completedAt = successfulScanCompletedAt_(config);
  if (!completedAt) {
    // No successful completion can be proven yet. Treat it as maximally overdue
    // so migration/failed-only conditions cannot be starved by hot conditions.
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(
    0,
    currentTime - completedAt - monitoringIntervalMs_(config)
  );
}

function isForcedOverdue_(config, now = Date.now()) {
  const completedAt = successfulScanCompletedAt_(config);
  if (!completedAt) {
    return true;
  }

  // "Sufficiently overdue" means one additional configured interval has elapsed
  // after the normal due point. This scales with each condition's own cadence.
  return (
    conditionOverdueMs_(config, now) >=
    monitoringIntervalMs_(config)
  );
}

function hasCursorContinuation_(config) {
  if (!config || typeof config !== 'object') {
    return false;
  }

  const market = String(config.market || '').trim();
  const defaultOffset = market === 'ヤフオク' ? 1 : 0;
  const scanOffset = Number(config.scanOffset);

  if (
    Number.isInteger(scanOffset) &&
    scanOffset > defaultOffset
  ) {
    return true;
  }

  const headState =
    config.headState &&
    typeof config.headState === 'object' &&
    !Array.isArray(config.headState)
      ? config.headState
      : {};

  return Boolean(
    (Array.isArray(headState.snapshotIds) && headState.snapshotIds.length > 0) ||
    String(headState.afterId || '').trim() ||
    Number(headState.offset || 0) > 0
  );
}

function hotPriorityScore_(config) {
  const explicit = Number(config && config.hotPriorityScore);
  if (Number.isFinite(explicit)) {
    return explicit;
  }

  // Backward-compatible minimal fallback until valuation/master metadata is
  // explicitly attached to getConfig. Do not invent unavailable profit data.
  const priority = String(config && config.priority || '').trim().toUpperCase();
  if (priority === 'S') return 2;
  if (priority === 'A') return 1;
  return 0;
}

function compareScheduledConditions_(a, b, now = Date.now()) {
  const aForced = isForcedOverdue_(a, now);
  const bForced = isForcedOverdue_(b, now);

  if (aForced !== bForced) {
    return aForced ? -1 : 1;
  }

  if (aForced && bForced) {
    const aOverdue = conditionOverdueMs_(a, now);
    const bOverdue = conditionOverdueMs_(b, now);

    if (aOverdue !== bOverdue) {
      if (aOverdue === Number.POSITIVE_INFINITY) return -1;
      if (bOverdue === Number.POSITIVE_INFINITY) return 1;
      return bOverdue - aOverdue;
    }
  }

  const aContinuation = hasCursorContinuation_(a);
  const bContinuation = hasCursorContinuation_(b);
  if (aContinuation !== bContinuation) {
    return aContinuation ? -1 : 1;
  }

  const aHot = hotPriorityScore_(a);
  const bHot = hotPriorityScore_(b);
  if (aHot !== bHot) {
    return bHot - aHot;
  }

  const aAttempt = Number(a && a.lastAttemptAt || 0);
  const bAttempt = Number(b && b.lastAttemptAt || 0);
  const safeAAttempt = Number.isFinite(aAttempt) && aAttempt > 0 ? aAttempt : 0;
  const safeBAttempt = Number.isFinite(bAttempt) && bAttempt > 0 ? bAttempt : 0;
  if (safeAAttempt !== safeBAttempt) {
    return safeAAttempt - safeBAttempt;
  }

  const aCompleted = successfulScanCompletedAt_(a);
  const bCompleted = successfulScanCompletedAt_(b);
  if (aCompleted !== bCompleted) {
    return aCompleted - bCompleted;
  }

  return String(a && a.conditionId || '')
    .localeCompare(String(b && b.conditionId || ''));
}

function selectConditionShard_(configs, env = process.env, now = Date.now()) {
  const count = Number(env.MONITOR_SHARD_COUNT || 1);
  const index = Number(env.MONITOR_SHARD_INDEX || 0);
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error('Invalid condition shard');
  }
  const currentTime = Number(now);
  if (!Number.isFinite(currentTime)) {
    throw new Error('Invalid condition scheduler timestamp');
  }
  const hash = id => {
    let value = 2166136261;
    for (const c of String(id)) value = Math.imul(value ^ c.charCodeAt(0), 16777619) >>> 0;
    return value;
  };
  return (configs || [])
    .filter(c => c && c.conditionId && hash(c.conditionId) % count === index)
    .slice()
    .sort((a, b) => compareScheduledConditions_(a, b, currentTime));
}

function selectDueConditions_(configs, now = Date.now()) {
  const currentTime = Number(now);

  if (!Number.isFinite(currentTime)) {
    throw new Error('Invalid condition due timestamp');
  }

  return (configs || []).filter(config => {
    if (!config || !config.conditionId) {
      return false;
    }

    const completedAt = successfulScanCompletedAt_(config);

    // Attempt time must never postpone work. A condition with no proven
    // successful completion remains due until a cursor commit succeeds.
    if (!completedAt) {
      return true;
    }

    return (
      currentTime - completedAt >=
      monitoringIntervalMs_(config)
    );
  });
}


function prioritizeYahooTargets_(items, now = Date.now()) {
  const byId = new Map();
  for (const item of items || []) {
    if (!item || !item.itemId || !item.conditionId) continue;
    const end = Date.parse(item.endTime || '');
    if (Number.isFinite(end) && end <= now) continue;
    if (!byId.has(item.itemId)) byId.set(item.itemId, item);
  }
  return [...byId.values()].sort((a, b) => {
    const ae = Date.parse(a.endTime || '');
    const be = Date.parse(b.endTime || '');
    const bucket = e => Number.isFinite(e) && e - now <= 90 * 60000 ? 0 : Number.isFinite(e) ? 2 : 1;
    return bucket(ae) - bucket(be) || Number(a.lastConfirmedAt || 0) - Number(b.lastConfirmedAt || 0) ||
      (Number.isFinite(ae) ? ae : Infinity) - (Number.isFinite(be) ? be : Infinity);
  });
}

async function runYahooDiscoveryCondition_(scan, options = {}) {
  const reason = options.fastMode && (options.circuitOpen
    ? 'GLOBAL_OUTAGE_CIRCUIT_OPEN' : options.budgetExpired ? 'DISCOVERY_BUDGET_EXHAUSTED' : '');
  if (reason) {
    if (options.onDeferred) options.onDeferred(reason);
    // No attempt acknowledgement or empty ingest: retain this condition's saved state.
    return { ok: true, deferred: true, reason };
  }
  if (options.fastMode && options.acknowledge) await options.acknowledge();
  return scan();
}

module.exports = {
  selectMercariHeadGap_,
  selectConditionShard_,
  selectConditionShardLegacy_,
  selectDueConditions_,
  selectDueConditionsLegacy_,
  monitoringIntervalMs_,
  successfulScanCompletedAt_,
  conditionOverdueMs_,
  isForcedOverdue_,
  hasCursorContinuation_,
  hotPriorityScore_,
  compareScheduledConditions_,
  prioritizeYahooTargets_,
  runYahooDiscoveryCondition_
};
