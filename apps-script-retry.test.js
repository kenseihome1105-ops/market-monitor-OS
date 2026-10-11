'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  shouldRetryAppsScriptResult_,
  appsScriptRetryDelayMs_
} = require('./apps-script-retry');

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

test('retries transient Spreadsheet service failures while attempts remain', () => {
  const result = {
    ok: false,
    error: 'Service Spreadsheets failed while accessing document with id example.'
  };

  assert.equal(
    shouldRetryAppsScriptResult_(result, 1, 5),
    true
  );
  assert.equal(
    shouldRetryAppsScriptResult_(result, 4, 5),
    true
  );
  assert.equal(
    shouldRetryAppsScriptResult_(result, 5, 5),
    false
  );
});

test('retries ScriptLock busy responses while attempts remain', () => {
  assert.equal(
    shouldRetryAppsScriptResult_(
      { ok: false, error: 'dirty世代開始: ScriptLock busy' },
      1,
      5
    ),
    true
  );
  assert.equal(
    shouldRetryAppsScriptResult_(
      { ok: false, error: 'dirty世代開始: ScriptLock busy' },
      5,
      5
    ),
    false
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

test('retry desync preserves zero-delay first attempt', () => {
  assert.equal(
    appsScriptRetryDelayMs_(0, 'workflow|run|shard-0', 1),
    0
  );
});

test('retry desync is deterministic and bounded', () => {
  const base = 6000;
  const identity = 'Market Monitor Test|123|monitor|0|Config|getConfig';
  const first = appsScriptRetryDelayMs_(base, identity, 3);
  const second = appsScriptRetryDelayMs_(base, identity, 3);

  assert.equal(first, second);
  assert.ok(first >= base);
  assert.ok(first <= base + 5000);
});

test('different worker identities desynchronize retry waits', () => {
  const shard0 = appsScriptRetryDelayMs_(
    2500,
    'Market Monitor Test|123|monitor|0|Config|getConfig',
    2
  );
  const shard1 = appsScriptRetryDelayMs_(
    2500,
    'Market Monitor Test|123|monitor|1|Config|getConfig',
    2
  );

  assert.notEqual(shard0, shard1);
});
