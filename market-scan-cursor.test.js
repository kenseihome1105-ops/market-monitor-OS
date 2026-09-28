'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_SCAN_ITEMS,
  defaultScanOffset_,
  selectOffsetBatch_,
  buildYahooScanUrl_
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
