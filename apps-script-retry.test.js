'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldRetryAppsScriptResult_ } = require('./apps-script-retry');

test('retries a busy response while attempts remain', () => {
  assert.equal(
    shouldRetryAppsScriptResult_({ ok: false, error: 'busy' }, 1, 5),
    true
  );
  assert.equal(
    shouldRetryAppsScriptResult_({ ok: false, error: 'busy' }, 4, 5),
    true
  );
});

test('does not retry success or permanent Apps Script errors', () => {
  assert.equal(
    shouldRetryAppsScriptResult_({ ok: true }, 1, 5),
    false
  );
  assert.equal(
    shouldRetryAppsScriptResult_({ ok: false, error: 'invalid secret' }, 1, 5),
    false
  );
});

test('does not retry once the configured attempt limit is reached', () => {
  assert.equal(
    shouldRetryAppsScriptResult_({ ok: false, error: 'busy' }, 5, 5),
    false
  );
});

test('rejects invalid attempt ranges', () => {
  assert.equal(
    shouldRetryAppsScriptResult_({ ok: false, error: 'busy' }, 0, 5),
    false
  );
  assert.equal(
    shouldRetryAppsScriptResult_({ ok: false, error: 'busy' }, 1, 0),
    false
  );
});
