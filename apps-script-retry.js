'use strict';

const APPS_SCRIPT_RETRY_JITTER_MAX_MS = 5000;

function stableHash32_(value) {
  const text = String(value || '');
  let hash = 2166136261;

  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function appsScriptRetryDelayMs_(baseDelayMs, identity, attempt) {
  const numericBase = Number(baseDelayMs);
  const base = Number.isFinite(numericBase)
    ? Math.max(0, Math.trunc(numericBase))
    : 0;
  const currentAttempt = Number(attempt);

  if (
    base === 0 ||
    !Number.isInteger(currentAttempt) ||
    currentAttempt < 1
  ) {
    return base;
  }

  const jitter =
    stableHash32_(
      `${String(identity || '')}|${currentAttempt}`
    ) %
    (APPS_SCRIPT_RETRY_JITTER_MAX_MS + 1);

  return base + jitter;
}

function shouldRetryAppsScriptResult_(result, attempt, maxAttempts) {
  const currentAttempt = Number(attempt);
  const maximumAttempts = Number(maxAttempts);
  const errorText = result && typeof result === 'object'
    ? String(result.error || '').trim()
    : '';
  const retryableBusy =
    errorText === 'busy' ||
    errorText.endsWith(': busy');

  const retryableSpreadsheetService =
    errorText.includes(
      'Service Spreadsheets failed while accessing document'
    );

  return Boolean(
    result &&
    typeof result === 'object' &&
    result.ok !== true &&
    (
      retryableBusy ||
      retryableSpreadsheetService
    ) &&
    Number.isInteger(currentAttempt) &&
    currentAttempt >= 1 &&
    Number.isInteger(maximumAttempts) &&
    maximumAttempts >= 1 &&
    currentAttempt < maximumAttempts
  );
}

module.exports = {
  shouldRetryAppsScriptResult_,
  appsScriptRetryDelayMs_
};
