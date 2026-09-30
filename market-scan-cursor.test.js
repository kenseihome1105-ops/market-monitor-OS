'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_SCAN_ITEMS,
  CURSOR_LOOKAHEAD_ITEMS,
  defaultScanOffset_,
  selectOffsetBatch_,
  selectCursorBatch_,
  mergeUniqueItemsById_,
  runConditionsIndependently_,
  rebaseYahooScanOffset_,
  normalizeYahooContinuationResult_,
  nextYahooScanOffset_,
  buildYahooScanUrl_,
  conditionShardIndex_,
  selectConditionShard_,
  shouldRetryYahooSearchStatus_
} = require('./market-scan-cursor');

function listings(count) {
  return Array.from({ length: count }, (_, i) => ({ itemId: `item-${i + 1}` }));
}

test('Mercari advances in batches of ten without repeating the prior range', () => {
  const all = listings(25);
  const first = selectOffsetBatch_(all, defaultScanOffset_('メルカリ'));
  const second = selectOffsetBatch_(all, first.nextOffset);

  assert.equal(first.items.length, MAX_SCAN_ITEMS);
  assert.deepEqual(first.items.map(x => x.itemId), listings(10).map(x => x.itemId));
  assert.equal(first.nextOffset, 10);
  assert.deepEqual(second.items.map(x => x.itemId), listings(25).slice(10, 20).map(x => x.itemId));
  assert.equal(second.nextOffset, 20);
});

test('the final short batch advances by the number actually consumed', () => {
  const result = selectOffsetBatch_(listings(25), 20);
  assert.equal(result.items.length, 5);
  assert.equal(result.nextOffset, 25);
});

test('Mercari resumes after the previous item ID when new listings shift the offset', () => {
  const current = [
    { itemId: 'new-1' },
    { itemId: 'new-2' },
    ...listings(25)
  ];
  const result = selectCursorBatch_(current, 'item-10', 10);

  assert.equal(CURSOR_LOOKAHEAD_ITEMS, 10);
  assert.equal(result.mode, 'REANCHORED_FORWARD');
  assert.equal(result.startOffset, 12);
  assert.deepEqual(
    result.items.map(item => item.itemId),
    ['item-11', 'item-12', 'item-13', 'item-14', 'item-15', 'item-16', 'item-17', 'item-18', 'item-19', 'item-20']
  );
  assert.equal(result.nextOffset, 22);
});

test('Mercari resets to the head when the prior anchor is no longer loaded', () => {
  const result = selectCursorBatch_(listings(15), 'expired-or-missing', 30);
  assert.equal(result.mode, 'RESET_ANCHOR_MISSING');
  assert.equal(result.startOffset, 0);
  assert.deepEqual(result.items.map(item => item.itemId), listings(10).map(item => item.itemId));
});

test('Mercari cursor advances through raw listing IDs even when a row has no eligible payload', () => {
  const rawIds = ['item-1', 'item-2', 'item-3', 'item-4'];
  const result = selectCursorBatch_(rawIds, 'item-2', 2, 2);

  assert.deepEqual(result.items, ['item-3', 'item-4']);
  assert.equal(result.nextOffset, 4);
});

test('head and continuation lanes merge once per item ID', () => {
  const merged = mergeUniqueItemsById_(
    [{ itemId: 'a', source: 'head' }, { itemId: 'b' }],
    [{ itemId: 'a', source: 'continuation' }, { itemId: 'c' }]
  );

  assert.deepEqual(merged, [
    { itemId: 'a', source: 'head' },
    { itemId: 'b' },
    { itemId: 'c' }
  ]);
});

test('a failed Yahoo condition does not prevent later conditions from running', async () => {
  const visited = [];
  const failures = await runConditionsIndependently_(
    [
      { conditionId: 'Y-05', searchName: 'first' },
      { conditionId: 'Y-06', searchName: 'transient failure' },
      { conditionId: 'BF_Y_09KNIT-023', searchName: 'backfill target' }
    ],
    async config => {
      visited.push(config.conditionId);
      if (config.conditionId === 'Y-06') {
        throw new Error('temporary Apps Script response error');
      }
    }
  );

  assert.deepEqual(visited, ['Y-05', 'Y-06', 'BF_Y_09KNIT-023']);
  assert.deepEqual(failures, [{
    conditionId: 'Y-06',
    searchName: 'transient failure',
    error: 'temporary Apps Script response error'
  }]);
});


test('a Yahoo scan result with ok:false is recorded and later conditions still run', async () => {
  const visited = [];
  const failures = await runConditionsIndependently_(
    [
      { conditionId: 'Y-05', searchName: 'first' },
      { conditionId: 'Y-06', searchName: 'search unavailable' },
      { conditionId: 'BF_Y_09KNIT-023', searchName: 'backfill target' }
    ],
    async config => {
      visited.push(config.conditionId);
      if (config.conditionId === 'Y-06') {
        return { ok: false, error: 'Yahoo search unavailable' };
      }
      return { ok: true };
    }
  );

  assert.deepEqual(visited, ['Y-05', 'Y-06', 'BF_Y_09KNIT-023']);
  assert.deepEqual(failures, [{
    conditionId: 'Y-06',
    searchName: 'search unavailable',
    error: 'Yahoo search unavailable'
  }]);
});

test('Yahoo rebases to the prior item ID after rows disappear before it', () => {
  const priorWindowIds = listings(10).map(item => item.itemId);
  const result = rebaseYahooScanOffset_(31, 'item-8', 21, priorWindowIds);

  assert.deepEqual(result, { offset: 29, mode: 'REANCHORED' });
});

test('Yahoo treats an empty continuation page as end-of-results after successful prior pages', () => {
  const headResult = {
    ok: true,
    items: [{ itemId: 'head-1' }],
    rawRowsRead: 1,
    rawItemIds: ['head-1'],
    lastRawItemId: 'head-1'
  };
  const lookbackResult = {
    ok: true,
    items: [{ itemId: 'anchor' }],
    rawRowsRead: 1,
    rawItemIds: ['anchor'],
    lastRawItemId: 'anchor'
  };
  const emptyContinuation = {
    ok: false,
    failureReason: 'NO_PRODUCT_CARDS',
    items: [],
    rawRowsRead: 0,
    rawItemIds: [],
    lastRawItemId: ''
  };

  const result = normalizeYahooContinuationResult_(
    headResult,
    lookbackResult,
    emptyContinuation
  );

  assert.equal(result.ok, true);
  assert.equal(result.endOfResults, true);
  assert.equal(result.rawRowsRead, 0);
  assert.equal(result.lastRawItemId, '');
  assert.equal(nextYahooScanOffset_(29, result.rawRowsRead), 1);
});

test('Yahoo keeps empty-page retrieval failures and failed prior pages as errors', () => {
  const headResult = { ok: true };
  const lookbackResult = { ok: true };
  const emptyContinuation = {
    ok: false,
    failureReason: 'NO_PRODUCT_CARDS',
    items: [],
    rawRowsRead: 0,
    rawItemIds: [],
    lastRawItemId: ''
  };
  const retrievalFailure = {
    ok: false,
    failureReason: 'SEARCH_RETRY_FAILED',
    items: [],
    rawRowsRead: 0,
    rawItemIds: [],
    lastRawItemId: ''
  };

  assert.strictEqual(
    normalizeYahooContinuationResult_(
      { ok: false },
      lookbackResult,
      emptyContinuation
    ),
    emptyContinuation
  );
  assert.strictEqual(
    normalizeYahooContinuationResult_(
      headResult,
      { ok: false },
      emptyContinuation
    ),
    emptyContinuation
  );
  assert.strictEqual(
    normalizeYahooContinuationResult_(
      headResult,
      lookbackResult,
      retrievalFailure
    ),
    retrievalFailure
  );
  assert.strictEqual(
    normalizeYahooContinuationResult_(
      emptyContinuation,
      null,
      emptyContinuation
    ),
    emptyContinuation
  );
});


test('Yahoo resets to the head if the previous auction ID has disappeared', () => {
  const result = rebaseYahooScanOffset_(31, 'ended-auction', 21, listings(10).map(item => item.itemId));
  assert.deepEqual(result, { offset: 1, mode: 'RESET_ANCHOR_MISSING' });
});

test('Yahoo offset advances by raw rows even if zero or fewer than ten pass buying filters', () => {
  assert.equal(nextYahooScanOffset_(1, 10), 11);
  assert.equal(nextYahooScanOffset_(31, 10), 41);
  assert.equal(nextYahooScanOffset_(11, 0), 1);
});

test('an exhausted listing page requests a reset instead of advancing past the end', () => {
  const result = selectOffsetBatch_(listings(15), 15);
  assert.deepEqual(result.items, []);
  assert.equal(result.nextOffset, null);
  assert.equal(defaultScanOffset_('メルカリ'), 0);
  assert.equal(defaultScanOffset_('ヤフオク'), 1);
});

test('Yahoo pagination changes only its one-based start and page size', () => {
  const url = buildYahooScanUrl_(
    'https://auctions.yahoo.co.jp/search/search?p=時計&b=1&n=50&s1=end&o1=a',
    31
  );
  const parsed = new URL(url);

  assert.equal(parsed.searchParams.get('p'), '時計');
  assert.equal(parsed.searchParams.get('s1'), 'end');
  assert.equal(parsed.searchParams.get('o1'), 'a');
  assert.equal(parsed.searchParams.get('b'), '31');
  assert.equal(parsed.searchParams.get('n'), '10');
});

test('invalid offsets and non-Yahoo URLs fail closed', () => {
  assert.throws(() => selectOffsetBatch_(listings(1), -1), /offset/);
  assert.throws(() => buildYahooScanUrl_('https://example.com/search', 1), /Yahoo/);
});


test('condition shards cover all configured conditions exactly once and remain stable when order changes', () => {
  const configs = Array.from({ length: 47 }, (_, index) => ({
    conditionId: `M-${String(index + 1).padStart(2, '0')}`
  }));
  const assignment = new Map();

  for (let shardIndex = 0; shardIndex < 6; shardIndex++) {
    const shard = selectConditionShard_(configs, shardIndex, 6);
    assert.ok(shard.length > 0);
    for (const config of shard) {
      assert.equal(conditionShardIndex_(config.conditionId, 6), shardIndex);
      assert.equal(assignment.has(config.conditionId), false);
      assignment.set(config.conditionId, shardIndex);
    }
  }

  assert.equal(assignment.size, configs.length);
  for (const config of [...configs].reverse()) {
    assert.equal(
      conditionShardIndex_(config.conditionId, 6),
      assignment.get(config.conditionId)
    );
  }
});

test('condition shard configuration rejects invalid input', () => {
  assert.throws(() => conditionShardIndex_('', 2), /conditionId/);
  assert.throws(() => selectConditionShard_([], 2, 2), /shardIndex/);
  assert.throws(() => selectConditionShard_([], 0, 0), /shardIndex/);
});

test('Yahoo search retries transient statuses but stops on permanent 4xx responses', () => {
  for (const status of [0, 408, 425, 429, 500, 502, 503, 504, 599]) {
    assert.equal(shouldRetryYahooSearchStatus_(status), true, String(status));
  }
  for (const status of [200, 400, 401, 403, 404]) {
    assert.equal(shouldRetryYahooSearchStatus_(status), false, String(status));
  }
});
