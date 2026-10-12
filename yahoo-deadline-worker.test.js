'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  processDeadlineBatch_,
  isTransientTrackingAttemptError_
} = require('./yahoo-deadline-worker');

test('treats Apps Script busy as transient tracking-attempt metadata failure', () => {
  assert.equal(
    isTransientTrackingAttemptError_(
      new Error('Tracking attempt側エラー: {"ok":false,"error":"busy","retryAfterMs":5000}')
    ),
    true
  );
});

test('treats Spreadsheet service failure as transient tracking-attempt metadata failure', () => {
  assert.equal(
    isTransientTrackingAttemptError_(
      new Error('Tracking attempt側エラー: {"ok":false,"error":"Service Spreadsheets failed while accessing document with id example."}')
    ),
    true
  );
});

test('does not suppress permanent tracking-attempt errors', () => {
  assert.equal(
    isTransientTrackingAttemptError_(
      new Error('Tracking attempt側エラー: {"ok":false,"error":"invalid secret"}')
    ),
    false
  );
});


test('continues other condition ingests when one condition is transiently busy', async () => {
  const now = Date.now();
  const targets = [
    { itemId: 'a1', conditionId: 'C1' },
    { itemId: 'b1', conditionId: 'C2' }
  ];
  const notified = [];

  const result = await processDeadlineBatch_(
    targets,
    async target => ({
      itemId: target.itemId,
      endTime: new Date(now + 600000).toISOString()
    }),
    async (items, conditionId) => {
      if (conditionId === 'C1') {
        throw new Error(
          'Ingest C1側エラー: {"ok":false,"error":"busy","retryAfterMs":5000}'
        );
      }
      return { ok: true };
    },
    async itemIds => {
      notified.push(...itemIds);
      return { notifications: { failed: 0 } };
    }
  );

  assert.equal(result.updated, 1);
  assert.deepEqual(result.ingestDeferredIds, ['a1']);
  assert.deepEqual(notified, ['b1']);
});

test('permanent ingest errors still fail closed', async () => {
  const now = Date.now();

  await assert.rejects(
    processDeadlineBatch_(
      [{ itemId: 'a1', conditionId: 'C1' }],
      async target => ({
        itemId: target.itemId,
        endTime: new Date(now + 600000).toISOString()
      }),
      async () => {
        throw new Error(
          'Ingest C1側エラー: {"ok":false,"error":"invalid secret"}'
        );
      },
      async () => ({ notifications: { failed: 0 } })
    ),
    /invalid secret/
  );
});
