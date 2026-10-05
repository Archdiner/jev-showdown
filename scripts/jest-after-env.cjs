const { formatNetworkFailure, takeNetworkAttempts } = require('./network-guard.cjs');

// GatewayClient retries and returns {ok:false} on a thrown fetch. The test
// still fails here, after the caller has swallowed the error.
afterEach(() => {
  const attempts = takeNetworkAttempts();
  if (attempts.length === 0) return;
  throw new Error(formatNetworkFailure(attempts));
});
