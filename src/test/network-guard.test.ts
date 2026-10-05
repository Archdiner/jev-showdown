import { GatewayClient } from '../llm/gateway-client.js';

const guard = (globalThis as unknown as {
  __jevNetworkGuard: {
    PROVIDER_KEYS: string[];
    takeNetworkAttempts: () => Array<{ method: string; url: string }>;
    formatNetworkFailure: (rows: Array<{ method: string; url: string }>) => string;
  };
}).__jevNetworkGuard;

describe('network guard', () => {
  it('clears provider keys before the suite reads them', () => {
    for (const key of guard.PROVIDER_KEYS) {
      expect(process.env[key]).toBeUndefined();
    }
  });

  it('throws on fetch and drops the query string from the recorded URL', () => {
    expect(() => fetch('https://ai-gateway.vercel.sh/v1/models?key=secret')).toThrow(
      /unit test attempted network: GET https:\/\/ai-gateway\.vercel\.sh\/v1\/models$/,
    );
    const attempts = guard.takeNetworkAttempts();
    expect(attempts).toEqual([
      { method: 'GET', url: 'https://ai-gateway.vercel.sh/v1/models' },
    ]);
    expect(guard.formatNetworkFailure(attempts)).toContain('GET https://ai-gateway.vercel.sh/v1/models');
    expect(guard.formatNetworkFailure(attempts)).not.toContain('secret');
  });

  it('records a gateway call that swallows the fetch error', async () => {
    process.env.VERCEL_AI_GATEWAY_KEY = 'test-key';
    try {
      const client = new GatewayClient({ maxRetries: 0, timeoutMs: 50 });
      const result = await client.listModels();
      expect(result.ok).toBe(false);
      const attempts = guard.takeNetworkAttempts();
      expect(attempts).toEqual([
        { method: 'GET', url: 'https://ai-gateway.vercel.sh/v1/models' },
      ]);
      expect(guard.formatNetworkFailure(attempts)).toMatch(/unit test reached the network/);
    } finally {
      delete process.env.VERCEL_AI_GATEWAY_KEY;
      guard.takeNetworkAttempts();
    }
  });
});
