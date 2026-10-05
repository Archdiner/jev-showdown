/**
 * Unit tests must not reach the network.
 * Jest setup clears provider keys and replaces global fetch with a stub that
 * records the attempt and throws. GatewayClient catches fetch errors and
 * returns {ok:false}, so the throw alone is not a test failure. setupFilesAfterEnv
 * fails the test when any attempt was recorded.
 */

const PROVIDER_KEYS = [
  'VERCEL_AI_GATEWAY_KEY',
  'AI_GATEWAY_API_KEY',
  'XAI_API_KEY',
  'OPENAI_API_KEY',
  'CEREBRAS_API_KEY',
  'POSTHOG_API_KEY',
];

const attempts = [];

function clearProviderKeys(env = process.env) {
  for (const key of PROVIDER_KEYS) delete env[key];
}

function describeUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && typeof input.url === 'string') return input.url;
  return String(input);
}

function stripQuery(url) {
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

function installFetchStub() {
  function jevTestFetch(input, init) {
    const method = String(
      (init && init.method)
      || (input && typeof input === 'object' && input.method)
      || 'GET',
    ).toUpperCase();
    const url = stripQuery(describeUrl(input));
    attempts.push({ method, url });
    const error = new Error(`unit test attempted network: ${method} ${url}`);
    error.name = 'JevTestNetworkError';
    error.jevTestStub = true;
    throw error;
  }
  jevTestFetch.jevTestStub = true;
  global.fetch = jevTestFetch;
  globalThis.fetch = jevTestFetch;
  globalThis.__jevNetworkGuard = {
    PROVIDER_KEYS,
    takeNetworkAttempts,
    formatNetworkFailure,
  };
  return jevTestFetch;
}

function takeNetworkAttempts() {
  return attempts.splice(0, attempts.length);
}

function formatNetworkFailure(rows) {
  const lines = rows.map(row => `${row.method} ${row.url}`).join('\n');
  return `unit test reached the network:\n${lines}`;
}

module.exports = {
  PROVIDER_KEYS,
  clearProviderKeys,
  installFetchStub,
  takeNetworkAttempts,
  formatNetworkFailure,
};
