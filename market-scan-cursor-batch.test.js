'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MARKET_SCAN_CURSOR_BATCH_MAX,
  createMarketScanCursorBatch_,
  normalizeMarketScanCursorAck_,
  recordMarketScanCursorAck_,
  buildMarketScanCursorBatchPayload_
} = require('./market-scan-cursor-batch');

test('records and builds deterministic Mercari cursor batch payload', () => {
  const batch = createMarketScanCursorBatch_();

  assert.equal(
    recordMarketScanCursorAck_(batch, {
      conditionId: 'M-02',
      market: 'メルカリ',
      nextOffset: 20,
      lastItemId: 'm200',
      headState: {
        baselineIds: ['m1', 'm2'],
        snapshotIds: ['m3'],
        offset: 2
      }
    }),
    true
  );

  assert.equal(
    recordMarketScanCursorAck_(batch, {
      conditionId: 'M-01',
      market: 'メルカリ',
      nextOffset: 10,
      lastItemId: 'm100',
      headState: {
        baselineIds: ['m9'],
        snapshotIds: [],
        offset: 0
      }
    }),
    true
  );

  const payload = buildMarketScanCursorBatchPayload_(batch, 'secret');

  assert.equal(payload.action, 'ackMarketScanCursorBatch');
  assert.equal(payload.secret, 'secret');
  assert.deepEqual(
    payload.cursors.map(item => item.conditionId),
    ['M-01', 'M-02']
  );
  assert.equal(payload.cursors[0].nextOffset, 10);
  assert.equal(payload.cursors[1].lastItemId, 'm200');
});

test('latest cursor for a condition replaces the earlier pending cursor', () => {
  const batch = createMarketScanCursorBatch_();

  recordMarketScanCursorAck_(batch, {
    conditionId: 'M-01',
    market: 'メルカリ',
    nextOffset: 10,
    lastItemId: 'm100',
    headState: {
      baselineIds: ['m1'],
      snapshotIds: [],
      offset: 0
    }
  });

  recordMarketScanCursorAck_(batch, {
    conditionId: 'M-01',
    market: 'メルカリ',
    nextOffset: 20,
    lastItemId: 'm200',
    headState: {
      baselineIds: ['m2'],
      snapshotIds: ['m3'],
      offset: 1
    }
  });

  const payload = buildMarketScanCursorBatchPayload_(batch, 'secret');

  assert.equal(payload.cursors.length, 1);
  assert.equal(payload.cursors[0].nextOffset, 20);
  assert.equal(payload.cursors[0].lastItemId, 'm200');
  assert.deepEqual(payload.cursors[0].headState.snapshotIds, ['m3']);
});

test('rejects invalid cursor state without adding it to the batch', () => {
  const batch = createMarketScanCursorBatch_();

  assert.equal(
    recordMarketScanCursorAck_(batch, {
      conditionId: 'M-01',
      market: 'メルカリ',
      nextOffset: -1,
      lastItemId: 'm100'
    }),
    false
  );

  assert.equal(
    recordMarketScanCursorAck_(batch, {
      conditionId: 'M-02',
      market: 'メルカリ',
      nextOffset: 0,
      headState: {
        baselineIds: new Array(11).fill('m1'),
        snapshotIds: [],
        offset: 0
      }
    }),
    false
  );

  assert.equal(batch.size, 0);
});

test('Yahoo cursor uses offset 1 minimum and cannot carry Mercari head state', () => {
  assert.equal(
    normalizeMarketScanCursorAck_({
      conditionId: 'Y-01',
      market: 'ヤフオク',
      nextOffset: 0
    }),
    null
  );

  assert.equal(
    normalizeMarketScanCursorAck_({
      conditionId: 'Y-01',
      market: 'ヤフオク',
      nextOffset: 1,
      headState: {
        baselineIds: [],
        snapshotIds: [],
        offset: 0
      }
    }),
    null
  );

  assert.equal(
    normalizeMarketScanCursorAck_({
      conditionId: 'Y-01',
      market: 'ヤフオク',
      nextOffset: 1,
      lastItemId: 'abc'
    }).nextOffset,
    1
  );
});

test('fails closed instead of silently dropping cursors over the batch limit', () => {
  const batch = createMarketScanCursorBatch_();

  for (let index = 0; index <= MARKET_SCAN_CURSOR_BATCH_MAX; index++) {
    recordMarketScanCursorAck_(batch, {
      conditionId: `M-${String(index).padStart(3, '0')}`,
      market: 'メルカリ',
      nextOffset: index
    });
  }

  assert.throws(
    () => buildMarketScanCursorBatchPayload_(batch, 'secret'),
    /exceeds/
  );
});
