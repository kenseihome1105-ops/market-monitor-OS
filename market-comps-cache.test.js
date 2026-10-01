'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMarketCompsCacheKey_,
  getOrLoadMarketComps_
} = require('./market-comps-cache');

test('Market Comps cache key is scoped to DB item and exact search URL', () => {
  const key = buildMarketCompsCacheKey_(
    'DB-001',
    'https://auctions.yahoo.co.jp/search/search?p=Kiton&category=2084043924'
  );

  assert.equal(
    key,
    buildMarketCompsCacheKey_(
      ' DB-001 ',
      ' https://auctions.yahoo.co.jp/search/search?p=Kiton&category=2084043924 '
    )
  );
  assert.notEqual(
    key,
    buildMarketCompsCacheKey_(
      'DB-002',
      'https://auctions.yahoo.co.jp/search/search?p=Kiton&category=2084043924'
    )
  );
  assert.notEqual(
    key,
    buildMarketCompsCacheKey_(
      'DB-001',
      'https://auctions.yahoo.co.jp/search/search?p=Kiton&category=2084043925'
    )
  );
});

test('reuses successful Yahoo comparisons within one run', async () => {
  const cache = new Map();
  const key = buildMarketCompsCacheKey_('DB-001', 'https://example.test/search?q=item');
  let loads = 0;
  const load = async () => {
    loads++;
    return { comparisons: [{ itemId: 'sold-1' }] };
  };

  const first = await getOrLoadMarketComps_(cache, key, load);
  const second = await getOrLoadMarketComps_(cache, key, load);

  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(loads, 1);
  assert.deepEqual(second.value, first.value);
});

test('does not cache failed or empty loads, allowing a later retry', async () => {
  const cache = new Map();
  const key = buildMarketCompsCacheKey_('DB-001', 'https://example.test/search?q=item');

  await assert.rejects(
    getOrLoadMarketComps_(cache, key, async () => {
      throw new Error('Yahoo unavailable');
    }),
    /Yahoo unavailable/
  );
  assert.equal(cache.has(key), false);

  const retried = await getOrLoadMarketComps_(cache, key, async () => ({
    comparisons: [{ itemId: 'sold-1' }]
  }));
  assert.equal(retried.cacheHit, false);

  await assert.rejects(
    getOrLoadMarketComps_(cache, 'empty', async () => null),
    /no value/
  );
});
