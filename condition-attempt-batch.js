'use strict';

function createConditionAttemptBatch_() {
  return new Map();
}

function recordConditionAttempt_(batch, conditionId, attemptedAt = Date.now()) {
  if (!(batch instanceof Map)) {
    throw new Error('condition attempt batch must be a Map');
  }

  const id = String(conditionId || '').trim();
  const at = Number(attemptedAt);

  if (!id || !Number.isFinite(at) || at <= 0) {
    return false;
  }

  const previous = Number(batch.get(id) || 0);
  if (!previous || at > previous) {
    batch.set(id, at);
  }

  return true;
}

function buildConditionAttemptBatchPayload_(batch, secret) {
  if (!(batch instanceof Map)) {
    throw new Error('condition attempt batch must be a Map');
  }

  const attempts = [...batch.entries()]
    .map(([conditionId, attemptedAt]) => ({
      conditionId: String(conditionId),
      attemptedAt: Number(attemptedAt)
    }))
    .filter(item => item.conditionId && Number.isFinite(item.attemptedAt) && item.attemptedAt > 0)
    .sort((a, b) =>
      a.attemptedAt - b.attemptedAt ||
      a.conditionId.localeCompare(b.conditionId)
    );

  return {
    secret,
    action: 'ackConditionAttempt',
    // Backward compatibility: current Apps Script already accepts batched itemIds.
    itemIds: attempts.map(item => item.conditionId),
    // Newer Apps Script can persist the actual per-condition attempt timestamps.
    attempts
  };
}

module.exports = {
  createConditionAttemptBatch_,
  recordConditionAttempt_,
  buildConditionAttemptBatchPayload_
};
