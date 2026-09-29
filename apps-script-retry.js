'use strict';

function shouldRetryAppsScriptResult_(result, attempt, maxAttempts) {
  const currentAttempt = Number(attempt);
  const maximumAttempts = Number(maxAttempts);

  return Boolean(
    result &&
    typeof result === 'object' &&
    result.ok !== true &&
    result.error === 'busy' &&
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
