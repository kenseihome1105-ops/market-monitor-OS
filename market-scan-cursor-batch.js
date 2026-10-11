'use strict';

const MARKET_SCAN_CURSOR_BATCH_MAX = 100;

function createMarketScanCursorBatch_() {
  return new Map();
}

function normalizeHeadState_(headState) {
  if (headState === undefined || headState === null) {
    return null;
  }

  if (!headState || typeof headState !== 'object' || Array.isArray(headState)) {
    return null;
  }

  const baselineIds = Array.isArray(headState.baselineIds)
    ? headState.baselineIds.map(value => String(value || '').trim()).filter(Boolean)
    : null;
  const snapshotIds = Array.isArray(headState.snapshotIds)
    ? headState.snapshotIds.map(value => String(value || '').trim()).filter(Boolean)
    : null;
  const offset = Number(headState.offset);

  if (
    baselineIds === null ||
    snapshotIds === null ||
    baselineIds.length > 10 ||
    snapshotIds.length > 10 ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    return null;
  }

  return {
    baselineIds,
    snapshotIds,
    offset
  };
}

function normalizeMarketScanCursorAck_(input) {
  const conditionId = String(input && input.conditionId || '').trim();
  const market = String(input && input.market || '').trim();
  const nextOffset = Number(input && input.nextOffset);
  const lastItemId = String(input && input.lastItemId || '').trim();
  const dbItemId = String(input && input.dbItemId || '').trim();
  const normalBuyLimit = Number(input && input.normalBuyLimit || 0);

  if (
    !conditionId ||
    (market !== 'メルカリ' && market !== 'ヤフオク') ||
    !Number.isInteger(nextOffset) ||
    nextOffset < (market === 'ヤフオク' ? 1 : 0)
  ) {
    return null;
  }

  let headState = null;
  if (input && input.headState !== undefined && input.headState !== null) {
    if (market !== 'メルカリ') {
      return null;
    }

    headState = normalizeHeadState_(input.headState);
    if (!headState) {
      return null;
    }
  }

  return {
    conditionId,
    market,
    nextOffset,
    lastItemId,
    dbItemId,
    normalBuyLimit: Number.isFinite(normalBuyLimit)
      ? Math.max(0, normalBuyLimit)
      : 0,
    headState
  };
}

function recordMarketScanCursorAck_(batch, input) {
  if (!(batch instanceof Map)) {
    throw new Error('market scan cursor batch must be a Map');
  }

  const normalized = normalizeMarketScanCursorAck_(input);
  if (!normalized) {
    return false;
  }

  batch.set(normalized.conditionId, normalized);
  return true;
}

function buildMarketScanCursorBatchPayload_(batch, secret) {
  if (!(batch instanceof Map)) {
    throw new Error('market scan cursor batch must be a Map');
  }

  const cursors = [...batch.values()]
    .map(normalizeMarketScanCursorAck_)
    .filter(Boolean)
    .sort((a, b) => a.conditionId.localeCompare(b.conditionId));

  if (cursors.length > MARKET_SCAN_CURSOR_BATCH_MAX) {
    throw new Error(
      `market scan cursor batch exceeds ${MARKET_SCAN_CURSOR_BATCH_MAX}`
    );
  }

  return {
    secret,
    action: 'ackMarketScanCursorBatch',
    cursors
  };
}

module.exports = {
  MARKET_SCAN_CURSOR_BATCH_MAX,
  createMarketScanCursorBatch_,
  normalizeMarketScanCursorAck_,
  recordMarketScanCursorAck_,
  buildMarketScanCursorBatchPayload_
};
