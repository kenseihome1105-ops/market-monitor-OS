'use strict';

function shouldRetryAppsScriptResult_(result, attempt, maxAttempts) {
  const currentAttempt = Number(attempt);
  const maximumAttempts = Number(maxAttempts);
  const errorText = result && typeof result === 'object'
    ? String(result.error || '').trim()
    : '';
  const retryableBusy =
    errorText === 'busy' ||
    errorText.endsWith(': busy');

  return Boolean(
    result &&
    typeof result === 'object' &&
    result.ok !== true &&
    retryableBusy &&
    Number.isInteger(currentAttempt) &&
    currentAttempt >= 1 &&
    Number.isInteger(maximumAttempts) &&
    maximumAttempts >= 1 &&
    currentAttempt < maximumAttempts
  );
}

module.exports = {
  shouldRetryAppsScriptResult_
};
