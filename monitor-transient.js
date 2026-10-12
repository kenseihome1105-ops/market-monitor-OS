'use strict';

function isTransientMercariNavigationError_(error) {
  const message =
    error && error.message
      ? String(error.message)
      : String(error || '');

  return (
    /page\.goto:\s*Timeout \d+ms exceeded\./.test(message) ||
    /net::ERR_(?:TIMED_OUT|CONNECTION_RESET|CONNECTION_CLOSED|NETWORK_CHANGED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED)\b/.test(message)
  );
}

module.exports = {
  isTransientMercariNavigationError_
};
