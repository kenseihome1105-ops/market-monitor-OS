'use strict';

function buildMarketCompsCacheKey_(dbItemId, searchUrl) {
  const normalizedDbItemId = String(dbItemId || '').trim();
  const normalizedSearchUrl = String(searchUrl || '').trim();

  if (!normalizedDbItemId) {
    throw new Error('Market Comps cache key requires a DB item ID');
  }
  if (!normalizedSearchUrl) {
    throw new Error('Market Comps cache key requires a search URL');
  }

  return JSON.stringify([normalizedDbItemId, normalizedSearchUrl]);
}

async function getOrLoadMarketComps_(cache, key, load) {
  if (!(cache instanceof Map)) {
    throw new TypeError('cache must be a Map');
  }

  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) {
    throw new Error('Market Comps cache key is empty');
  }
  if (typeof load !== 'function') {
    throw new TypeError('load must be a function');
  }

  if (cache.has(normalizedKey)) {
    return {
      value: cache.get(normalizedKey),
      cacheHit: true
    };
  }

  const value = await load();
  if (value === undefined || value === null) {
    throw new Error('Market Comps loader returned no value');
  }

  // Failed loads are never cached; a later duplicate can retry the source.
  cache.set(normalizedKey, value);
  return {
    value,
    cacheHit: false
  };
}

module.exports = {
  buildMarketCompsCacheKey_,
  getOrLoadMarketComps_
};
