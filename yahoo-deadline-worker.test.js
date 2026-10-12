'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
