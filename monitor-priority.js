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

function selectConditionShard_(configs, env = process.env) {
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
  return configs.filter(c => hash(c.conditionId) % count === index).sort((a, b) =>
    Number(a.lastScannedAt || 0) - Number(b.lastScannedAt || 0) ||
    String(a.conditionId).localeCompare(String(b.conditionId))
  );
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

module.exports = { selectMercariHeadGap_, selectConditionShard_, prioritizeYahooTargets_, runYahooDiscoveryCondition_ };
