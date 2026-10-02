'use strict';

const MAX_SCAN_ITEMS = 10;
const CURSOR_LOOKAHEAD_ITEMS = MAX_SCAN_ITEMS;

function defaultScanOffset_(market) {
  return String(market || '').trim() === 'ヤフオク' ? 1 : 0;
}

/**
 * Force Mercari sourcing searches to active listings while preserving the
 * configured keyword, brand, category, sort, and other search parameters.
 */
function enforceMercariActiveSearchUrl_(searchUrl) {
  let url;
  try {
    url = new URL(String(searchUrl || '').trim());
  } catch (error) {
    throw new Error('Mercari検索URLが不正です');
  }

  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'jp.mercari.com' ||
    url.port ||
    url.username ||
    url.password ||
    !['/search', '/search/'].includes(url.pathname)
  ) {
    throw new Error('Mercari検索URLではありません');
  }

  url.searchParams.set('status', 'on_sale');
  if (url.searchParams.get('status') !== 'on_sale') {
    throw new Error('Mercari検索URLの販売中指定に失敗しました');
  }

  return url.toString();
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

/**
 * Resume a zero-based Mercari scan from the previous raw item ID.
 * A missing anchor fails closed to the head so a shifted feed cannot silently
 * skip rows. The caller relies on item-ID upsert/dedupe for safe replay.
 */
function selectCursorBatch_(items, lastItemId, fallbackOffset, limit = MAX_SCAN_ITEMS) {
  if (!Array.isArray(items)) {
    throw new TypeError('items must be an array');
  }

  const size = Number(limit);
  if (!Number.isInteger(size) || size < 1 || size > MAX_SCAN_ITEMS) {
    throw new RangeError(`limit must be between 1 and ${MAX_SCAN_ITEMS}`);
  }

  const anchor = String(lastItemId || '').trim();
  const fallback = Number(fallbackOffset);
  if (!Number.isInteger(fallback) || fallback < 0) {
    throw new RangeError('fallbackOffset must be a non-negative integer');
  }

  let startIndex = 0;
  let mode = 'HEAD';

  if (anchor) {
    const anchorIndex = items.findIndex(item => {
      const itemId = typeof item === 'string'
        ? item
        : String(item && item.itemId || '');
      return String(itemId || '').trim() === anchor;
    });
    if (anchorIndex >= 0) {
      startIndex = anchorIndex + 1;
      mode = startIndex > fallback ? 'REANCHORED_FORWARD' : 'REANCHORED';
    } else {
      mode = 'RESET_ANCHOR_MISSING';
    }
  } else if (fallback > 0) {
    // Legacy offset-only state is not trusted against a mutable result order.
    mode = 'RESET_ANCHOR_MISSING';
  }

  const batch = items.slice(startIndex, startIndex + size);
  return {
    items: batch,
    startOffset: startIndex,
    nextOffset: batch.length ? startIndex + batch.length : null,
    mode
  };
}

function mergeUniqueItemsById_(...batches) {
  const byId = new Map();
  for (const batch of batches) {
    if (!Array.isArray(batch)) continue;
    for (const item of batch) {
      const itemId = String(item && item.itemId || '').trim();
      if (itemId && !byId.has(itemId)) byId.set(itemId, item);
    }
  }
  return Array.from(byId.values());
}

/** Run each marketplace condition independently so one transient ingest error
 * cannot prevent later conditions from being scanned. Errors are returned for
 * a final workflow failure after the remaining conditions finish.
 */
async function runConditionsIndependently_(configs, runCondition, onFailure) {
  if (!Array.isArray(configs)) {
    throw new TypeError('configs must be an array');
  }
  if (typeof runCondition !== 'function') {
    throw new TypeError('runCondition must be a function');
  }

  const failures = [];
  for (let index = 0; index < configs.length; index++) {
    const config = configs[index] || {};
    try {
      const result = await runCondition(config, index);
      if (result && typeof result === 'object' && result.ok === false) {
        throw new Error(
          String(result.error || '条件処理がok:falseを返しました')
        );
      }
    } catch (error) {
      const failure = {
        conditionId: String(config.conditionId || '').trim(),
        searchName: String(config.searchName || '').trim(),
        error: error && error.message ? error.message : String(error)
      };
      failures.push(failure);
      if (typeof onFailure === 'function') {
        onFailure(failure, index, config);
      }
    }
  }

  return failures;
}

/**
 * Rebase Yahoo's one-based offset by locating the prior page-boundary ID in
 * the current lookback page. If the anchor expired or moved outside the
 * bounded window, restart at the head and let item-ID dedupe absorb replay.
 */
function rebaseYahooScanOffset_(storedOffset, lastItemId, lookbackOffset, rawItemIds) {
  const stored = Number(storedOffset);
  const start = Number(lookbackOffset);
  if (!Number.isInteger(stored) || stored < 1) {
    throw new RangeError('storedOffset must be a positive integer');
  }
  if (!Number.isInteger(start) || start < 1) {
    throw new RangeError('lookbackOffset must be a positive integer');
  }
  if (!Array.isArray(rawItemIds)) {
    throw new TypeError('rawItemIds must be an array');
  }

  const anchor = String(lastItemId || '').trim();
  if (stored === 1 && !anchor) {
    return { offset: 1, mode: 'HEAD' };
  }

  const anchorIndex = anchor
    ? rawItemIds.findIndex(itemId => String(itemId || '').trim() === anchor)
    : -1;
  if (anchorIndex >= 0) {
    return {
      offset: start + anchorIndex + 1,
      mode: 'REANCHORED'
    };
  }

  return { offset: 1, mode: 'RESET_ANCHOR_MISSING' };
}

/**
 * An empty continuation page is a valid end-of-results only when the head
 * and any lookback page both loaded successfully. Resetting to the head lets
 * mutable Yahoo results be scanned again next run without advancing past data.
 */
function normalizeYahooContinuationResult_(headResult, lookbackResult, continuationResult) {
  const priorPagesSucceeded =
    headResult &&
    headResult.ok === true &&
    (!lookbackResult || lookbackResult.ok === true);
  const isDistinctContinuation =
    Boolean(continuationResult) &&
    continuationResult !== headResult &&
    continuationResult !== lookbackResult;

  if (
    !priorPagesSucceeded ||
    !isDistinctContinuation ||
    continuationResult.ok !== false ||
    continuationResult.failureReason !== 'NO_PRODUCT_CARDS'
  ) {
    return continuationResult;
  }

  return {
    ...continuationResult,
    ok: true,
    items: [],
    rawRowsRead: 0,
    rawItemIds: [],
    lastRawItemId: '',
    endOfResults: true
  };
}

/** Advance Yahoo by raw result rows, independent of title/price filtering. */
function nextYahooScanOffset_(currentOffset, rawRowsRead) {
  const current = Number(currentOffset);
  const read = Number(rawRowsRead);
  if (!Number.isInteger(current) || current < 1) {
    throw new RangeError('currentOffset must be a positive integer');
  }
  if (!Number.isInteger(read) || read < 0 || read > MAX_SCAN_ITEMS) {
    throw new RangeError(`rawRowsRead must be between 0 and ${MAX_SCAN_ITEMS}`);
  }
  return read > 0 ? current + read : 1;
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

/**
 * Accept Yahoo HTTP 404 only when it is the official search-results route and
 * verified product cards are present. An empty or unrelated 404 must fail
 * closed so the caller cannot advance its scan cursor.
 */
function shouldAcceptYahoo404Search_(status, responseUrl, title, productCardCount) {
  if (Number(status) !== 404 || Number(productCardCount) < 1) {
    return false;
  }

  let url;
  try {
    url = new URL(String(responseUrl || ''));
  } catch (error) {
    return false;
  }

  return (
    url.protocol === 'https:' &&
    url.hostname === 'auctions.yahoo.co.jp' &&
    url.pathname === '/search/search' &&
    String(title || '').includes('Yahoo!オークション')
  );
}


function isYahooSearchResultsPage_(responseUrl, title) {
  let url;
  try {
    url = new URL(String(responseUrl || ''));
  } catch (error) {
    return false;
  }

  return (
    url.protocol === 'https:' &&
    url.hostname === 'auctions.yahoo.co.jp' &&
    url.pathname === '/search/search' &&
    String(title || '').includes('Yahoo!オークション')
  );
}


function areAllYahooSearchResultsGlobalFailures_(results) {
  return (
    Array.isArray(results) &&
    results.length > 0 &&
    results.every(result =>
      result && result.globalUpstreamFailure === true
    )
  );
}

function shouldOpenYahooSearchCircuit_(consecutiveGlobalFailures, threshold = 3) {
  const failures = Number(consecutiveGlobalFailures);
  const limit = Number(threshold);
  return (
    Number.isInteger(failures) &&
    failures >= 1 &&
    Number.isInteger(limit) &&
    limit >= 1 &&
    failures >= limit
  );
}

module.exports = {
  MAX_SCAN_ITEMS,
  CURSOR_LOOKAHEAD_ITEMS,
  defaultScanOffset_,
  enforceMercariActiveSearchUrl_,
  selectOffsetBatch_,
  selectCursorBatch_,
  mergeUniqueItemsById_,
  runConditionsIndependently_,
  rebaseYahooScanOffset_,
  normalizeYahooContinuationResult_,
  nextYahooScanOffset_,
  buildYahooScanUrl_,
  shouldAcceptYahoo404Search_,
  isYahooSearchResultsPage_,
  shouldOpenYahooSearchCircuit_,
  areAllYahooSearchResultsGlobalFailures_
};
