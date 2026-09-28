'use strict';

const MAX_SCAN_ITEMS = 10;

function defaultScanOffset_(market) {
  return String(market || '').trim() === 'ヤフオク' ? 1 : 0;
}

function selectOffsetBatch_(items, offset, limit = MAX_SCAN_ITEMS) {
  if (!Array.isArray(items)) {
    throw new TypeError('items must be an array');
  }

  const start = Number(offset);
  const size = Number(limit);

  if (!Number.isInteger(start) || start < 0) {
    throw new RangeError('offset must be a non-negative integer');
  }
  if (!Number.isInteger(size) || size < 1 || size > MAX_SCAN_ITEMS) {
    throw new RangeError(`limit must be between 1 and ${MAX_SCAN_ITEMS}`);
  }

  const batch = items.slice(start, start + size);
  return {
    items: batch,
    nextOffset: batch.length ? start + batch.length : null
  };
}

function buildYahooScanUrl_(searchUrl, oneBasedOffset, pageSize = MAX_SCAN_ITEMS) {
  let url;
  try {
    url = new URL(String(searchUrl || '').trim());
  } catch (error) {
    throw new Error('Yahoo検索URLが不正です');
  }

  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'auctions.yahoo.co.jp' ||
    url.pathname !== '/search/search'
  ) {
    throw new Error('Yahoo検索URLではありません');
  }

  const offset = Number(oneBasedOffset);
  const size = Number(pageSize);
  if (!Number.isInteger(offset) || offset < 1) {
    throw new RangeError('Yahoo offset must be a positive integer');
  }
  if (!Number.isInteger(size) || size < 1 || size > MAX_SCAN_ITEMS) {
    throw new RangeError(`Yahoo page size must be between 1 and ${MAX_SCAN_ITEMS}`);
  }

  url.searchParams.set('b', String(offset));
  url.searchParams.set('n', String(size));
  return url.toString();
}

module.exports = {
  MAX_SCAN_ITEMS,
  defaultScanOffset_,
  selectOffsetBatch_,
  buildYahooScanUrl_
};
