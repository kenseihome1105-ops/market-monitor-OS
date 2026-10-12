'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isTransientMercariNavigationError_
} = require('./monitor-transient');

test('treats Mercari page.goto timeout as transient', () => {
  assert.equal(
    isTransientMercariNavigationError_(
      new Error('page.goto: Timeout 60000ms exceeded.\nCall log:\n - navigating')
    ),
    true
  );
});

test('treats transient Chromium network errors as transient', () => {
  assert.equal(
    isTransientMercariNavigationError_(
      new Error('page.goto: net::ERR_CONNECTION_RESET at https://jp.mercari.com/search')
    ),
    true
  );
});

test('does not hide parser or configuration failures', () => {
  assert.equal(
    isTransientMercariNavigationError_(
      new Error('Mercari cursor state invalid')
    ),
    false
  );
  assert.equal(
    isTransientMercariNavigationError_(
      new Error('Invalid Mercari search URL')
    ),
    false
  );
});
