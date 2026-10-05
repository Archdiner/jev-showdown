import { notifyLlmObservers, observeLlmCalls, type CallMetrics } from '../llm/gateway-client.js';
import { buildLadderGameRecord, type LadderGameInput } from './game-record.js';
import { installPosthogSink, posthogSinkFromEnv, resetPosthogSinkForTests, PosthogSink } from './posthog-sink.js';

function record(): ReturnType<typeof buildLadderGameRecord> {
  const input: LadderGameInput = {
    ts: 2_000,
    startedAt: 1_000,
    battleId: 'battle-gen9randombattle-1',
    format: 'gen9randombattle',
    username: 'BotAlpha',
    opponent: 'Rival',
    opponentRating: 1400,
    lines: ['|win|BotAlpha'],
    winner: 'BotAlpha',
    turns: 4,
    invalidChoices: 0,
    crashes: 0,
    fallbacks: 0,
    mismatches: 0,
    eloBefore: 1073,
    eloAfter: 1089,
    gxe: null,
    latencies: [12],
    minTimerMarginSec: 18,
    engine: 'max-damage',
    configId: null,
    configHash: 'abc',
    gitSha: '87b268f',
    concurrency: 1,
    replayId: 'gen9randombattle-1',
    replayUrl: null,
    localReplayPath: '/tmp/secret-path.log',
    localServer: false,
    disconnected: false,
    logPath: '/tmp/game.jsonl',
  };
  return buildLadderGameRecord(input);
}

const metrics: CallMetrics = {
  model: 'spacexai/grok-4.7',
  latencyMs: 40,
  tokensInput: 10,
  tokensOutput: 2,
  costUsd: 0.0001,
  status: 'ok',
  attempts: 1,
};

describe('optional PostHog sink', () => {
  const previousKey = process.env.POSTHOG_API_KEY;
  const previousHost = process.env.POSTHOG_HOST;
  const previousTraces = process.env.POSTHOG_LLM_TRACES;

  afterEach(() => {
    if (previousKey === undefined) delete process.env.POSTHOG_API_KEY;
    else process.env.POSTHOG_API_KEY = previousKey;
    if (previousHost === undefined) delete process.env.POSTHOG_HOST;
    else process.env.POSTHOG_HOST = previousHost;
    if (previousTraces === undefined) delete process.env.POSTHOG_LLM_TRACES;
    else process.env.POSTHOG_LLM_TRACES = previousTraces;
    resetPosthogSinkForTests();
  });

  it('stays off when POSTHOG_API_KEY is unset', () => {
    delete process.env.POSTHOG_API_KEY;
    expect(posthogSinkFromEnv()).toBeNull();
    expect(installPosthogSink()).toBeNull();
  });

  it('queues a game event and does not wait on the network', async () => {
    let posted = '';
    let url = '';
    let release: (value: Response) => void = () => undefined;
    const pending = new Promise<Response>(resolve => {
      release = resolve;
    });
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      url = input;
      posted = String(init?.body ?? '');
      return pending;
    }) as typeof fetch;
    const client = new PosthogSink('phc_test', 'https://example.test', fetchImpl);
    client.captureGame(record());
    expect(posted).toBe('');
    const done = client.shutdown();
    expect(url).toBe('https://example.test/batch/');
    expect(posted).toContain('"event":"ladder_game"');
    expect(posted).toContain('"opponentRating":1400');
    expect(posted).toContain('"gxe":null');
    expect(posted).not.toContain('secret-path');
    expect(posted).not.toContain('password');
    const properties = JSON.parse(posted).batch[0].properties;
    expect(properties.api_key).toBeUndefined();
    release(new Response('ok', { status: 200 }));
    await done;
  });

  it('swallows a failed flush', async () => {
    const fetchImpl = (async () => {
      throw new Error('down');
    }) as typeof fetch;
    const client = new PosthogSink('phc_test', 'https://example.test', fetchImpl);
    client.captureGame(record());
    await expect(client.shutdown()).resolves.toBeUndefined();
  });

  it('sends LLM metrics without a prompt when traces are enabled', async () => {
    process.env.POSTHOG_API_KEY = 'phc_test';
    process.env.POSTHOG_HOST = 'https://example.test/';
    process.env.POSTHOG_LLM_TRACES = '1';
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    resetPosthogSinkForTests();
    const client = posthogSinkFromEnv(fetchImpl);
    expect(client).not.toBeNull();
    client?.captureLlm(metrics);
    await client?.shutdown();
    expect(bodies[0]).toContain('"$ai_generation"');
    expect(bodies[0]).toContain('spacexai/grok-4.7');
    expect(bodies[0]).not.toContain('prompt');

    const seen: CallMetrics[] = [];
    const stop = observeLlmCalls(item => seen.push(item));
    notifyLlmObservers(metrics);
    expect(seen).toEqual([metrics]);
    stop();
    notifyLlmObservers(metrics);
    expect(seen).toHaveLength(1);
  });
});
