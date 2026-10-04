'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createConditionAttemptBatch_,
  recordConditionAttempt_,
  buildConditionAttemptBatchPayload_
} = require('./condition-attempt-batch');

test('condition attempts are batched into one payload while retaining per-condition timestamps', () => {
  const batch = createConditionAttemptBatch_();
  recordConditionAttempt_(batch, 'BF_M_A', 1000);
  recordConditionAttempt_(batch, 'BF_M_B', 2000);
  const payload = buildConditionAttemptBatchPayload_(batch, 'secret');

  assert.equal(payload.action, 'ackConditionAttempt');
  assert.equal(payload.secret, 'secret');
  assert.deepEqual(payload.itemIds, ['BF_M_A', 'BF_M_B']);
  assert.deepEqual(payload.attempts, [
    { conditionId: 'BF_M_A', attemptedAt: 1000 },
    { conditionId: 'BF_M_B', attemptedAt: 2000 }
  ]);
});

test('duplicate condition keeps its latest actual attempt time', () => {
  const batch = createConditionAttemptBatch_();
  recordConditionAttempt_(batch, 'BF_M_A', 1000);
  recordConditionAttempt_(batch, 'BF_M_A', 900);
  recordConditionAttempt_(batch, 'BF_M_A', 1500);

  const payload = buildConditionAttemptBatchPayload_(batch, 'secret');
  assert.deepEqual(payload.attempts, [
    { conditionId: 'BF_M_A', attemptedAt: 1500 }
  ]);
});

test('invalid attempts are ignored and never create fake fairness state', () => {
  const batch = createConditionAttemptBatch_();
  assert.equal(recordConditionAttempt_(batch, '', 1000), false);
  assert.equal(recordConditionAttempt_(batch, 'BF_M_A', 0), false);
  assert.deepEqual(buildConditionAttemptBatchPayload_(batch, 'secret').attempts, []);
});
