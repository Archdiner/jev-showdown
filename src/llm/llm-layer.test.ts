import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GatewayClient, resetRestrictionLatch } from './gateway-client.js';
import { JevAdvisor } from './jev-advisor.js';
import { blendCandidates, blendConfigForBot, chooseAction } from './blend.js';
import { LossReviewer, buildReviewMessages, formatJsonl } from './loss-reviewer.js';
import { buildBattleFacts, effectiveSpeed } from './battle-facts.js';
import { garchompRotomFixture } from './garchomp-rotom-fixture.js';
import { capEvaluationState } from './state-summary.js';
import { challengerBlendConfig, loadJevPriorExperiment } from './experiment-config.js';
import { DEFAULT_REVIEWER_MODEL_ID, JEV_MODEL_ID, estimateCostUsd } from './models.js';
import { MAX_EVALUATION_STATE_TOKENS } from './state-summary.js';
import { GraphDB } from '../graph/db.js';
import type { AdvisorCandidate } from './types.js';
import type { GameState } from '../types/index.js';

const KEY = 'super-secret-key-xyz';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function scriptedFetch(steps: Array<Response | Error>): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const next = steps.shift();
    if (!next) throw new Error('no scripted response');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch: fetchImpl, calls };
}

function candidates(): AdvisorCandidate[] {
  return [
    { id: 'a0', label: 'tackle', action: { type: 'move', moveIndex: 1 }, searchScore: 10 },
    { id: 'a1', label: 'switch', action: { type: 'switch', switchIndex: 2 }, searchScore: 9.96 },
  ];
}

describe('gateway client', () => {
  it('degrades when the key is missing and does not call the network', async () => {
    const script = scriptedFetch([]);
    const client = new GatewayClient({ apiKey: '', fetchImpl: script.fetch, log: () => {} });
    const result = await client.chat({ model: 'spacexai/grok-4.7', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('missing_api_key');
    expect(script.calls).toHaveLength(0);
  });

  it('retries a retryable status and then returns cost and latency', async () => {
    const script = scriptedFetch([
      new Response('unavailable', { status: 503 }),
      jsonResponse({
        choices: [{ message: { content: 'pong' } }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
        providerMetadata: { gateway: { cost: '0.000044' } },
      }),
    ]);
    const client = new GatewayClient({
      apiKey: KEY,
      fetchImpl: script.fetch,
      log: () => {},
      maxRetries: 1,
      perTurnLatencyBudgetMs: 5000,
    });
    const result = await client.chat({ model: DEFAULT_REVIEWER_MODEL_ID, messages: [{ role: 'user', content: 'ping' }] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe('pong');
    expect(result.metrics.attempts).toBe(2);
    expect(result.metrics.costUsd).toBeCloseTo(0.000044);
    expect(result.metrics.tokensInput).toBe(10);
    expect(result.metrics.latencyMs).toBeGreaterThanOrEqual(0);
    expect(script.calls).toHaveLength(2);
  });

  it('stops when the per-turn budget is already spent', async () => {
    const script = scriptedFetch([]);
    const client = new GatewayClient({
      apiKey: KEY,
      fetchImpl: script.fetch,
      log: () => {},
      perTurnLatencyBudgetMs: 0,
    });
    const result = await client.evaluate({
      model: JEV_MODEL_ID,
      state: 'x',
      questions: { ping: { type: 'boolean', instructions: 'ping' } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('latency_budget_exceeded');
    expect(script.calls).toHaveLength(0);
  });

  it('redacts the api key from errors and logs', async () => {
    const logs: string[] = [];
    const script = scriptedFetch([new Error(`auth failed ${KEY}`)]);
    const client = new GatewayClient({
      apiKey: KEY,
      fetchImpl: script.fetch,
      log: line => logs.push(line),
      maxRetries: 0,
    });
    const result = await client.chat({ model: 'spacexai/grok-4.7', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('auth failed [redacted]');
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(logs.join('\n')).not.toContain(KEY);
  });

  it('does not retry a restricted model and logs the fallback once', async () => {
    resetRestrictionLatch();
    const logs: string[] = [];
    const script = scriptedFetch([
      new Response(JSON.stringify({ error: { code: 'RestrictedModelsError', message: 'free tier' } }), { status: 403 }),
      jsonResponse({ choices: [{ message: { content: 'pong' } }] }),
    ]);
    const client = new GatewayClient({
      apiKey: KEY,
      fetchImpl: script.fetch,
      log: line => logs.push(line),
      maxRetries: 2,
    });
    const first = await client.chat({ model: DEFAULT_REVIEWER_MODEL_ID, messages: [{ role: 'user', content: 'hi' }] });
    const second = await client.chat({ model: DEFAULT_REVIEWER_MODEL_ID, messages: [{ role: 'user', content: 'again' }] });
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error).toBe('restricted_model');
    expect(second.ok).toBe(false);
    expect(script.calls).toHaveLength(1);
    expect(logs.filter(line => line.includes('RestrictedModelsError'))).toHaveLength(1);
    resetRestrictionLatch();
  });

  it('aborts when the request exceeds the timeout budget', async () => {
    const fetchImpl: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'TimeoutError';
        reject(error);
      });
    });
    const client = new GatewayClient({
      apiKey: KEY,
      fetchImpl,
      log: () => {},
      timeoutMs: 30,
      maxRetries: 0,
      perTurnLatencyBudgetMs: 30,
    });
    const result = await client.chat({ model: 'spacexai/grok-4.7', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('timeout');
  });
});

describe('Jev advisor', () => {
  it('posts one evaluate request with a string state, a choice, scores, and a boolean', async () => {
    resetRestrictionLatch();
    const script = scriptedFetch([jsonResponse({
      model: JEV_MODEL_ID,
      answers: {
        bestAction: { type: 'choice', choice: 'a1', probabilities: { a0: 0.25, a1: 0.75 } },
        score_a0: { type: 'score', score: 1, probabilities: { '0': 0, '1': 1, '2': 0, '3': 0, '4': 0 } },
        score_a1: { type: 'score', score: 4, probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 1 } },
        opponentWillSwitch: { type: 'boolean', probability: 0.2 },
      },
      usage: { inputTokens: 100, outputTokens: 20 },
      providerMetadata: { gateway: { cost: '0.0000042', marketCost: '0.0000042', generationId: 'gen_test' } },
    })]);
    const client = new GatewayClient({ apiKey: KEY, fetchImpl: script.fetch, log: () => {} });
    const advisor = new JevAdvisor(client);
    const assessment = await advisor.advise(sampleState(), candidates());
    expect(assessment.degraded).toBe(false);
    expect(assessment.probabilities.a1).toBe(0.75);
    expect(assessment.scores.a1).toBe(1);
    expect(assessment.scores.a0).toBe(0.25);
    expect(assessment.booleans.opponentWillSwitch).toBe(0.2);
    expect(assessment.costUsd).toBeCloseTo(0.0000042);
    expect(script.calls).toHaveLength(1);
    expect(script.calls[0].url).toBe('https://ai-gateway.vercel.sh/v1/evaluate');
    expect(script.calls[0].init?.method).toBe('POST');
    expect(script.calls[0].url).not.toContain('chat/completions');

    const body = JSON.parse(String(script.calls[0].init?.body));
    expect(body.model).toBe('typesafe-ai/jev');
    expect(typeof body.state).toBe('string');
    expect(body.state.length).toBeLessThanOrEqual(MAX_EVALUATION_STATE_TOKENS * 4);
    expect(body.questions.bestAction.type).toBe('choice');
    expect(Array.isArray(body.questions.bestAction.criteria)).toBe(false);
    expect(typeof body.questions.bestAction.criteria.a0).toBe('string');
    expect(typeof body.questions.bestAction.criteria.a1).toBe('string');
    expect(body.questions.opponentWillSwitch).toEqual({
      type: 'boolean',
      instructions: expect.any(String),
      criteria: {
        true: expect.any(String),
        false: expect.any(String),
      },
    });
    expect(body.questions.score_a0.type).toBe('score');
    expect(body.questions.score_a0.criteria.length).toBeGreaterThanOrEqual(2);
    expect(body.questions.score_a0.criteria.length).toBeLessThanOrEqual(10);
  });

  it('falls back to pure search on 403 RestrictedModelsError, logged once and not retried', async () => {
    resetRestrictionLatch();
    const logs: string[] = [];
    const script = scriptedFetch([
      new Response(JSON.stringify({ error: { code: 'RestrictedModelsError', message: 'free tier' } }), { status: 403 }),
      jsonResponse({ answers: {} }),
    ]);
    const client = new GatewayClient({
      apiKey: KEY,
      fetchImpl: script.fetch,
      log: line => logs.push(line),
      maxRetries: 2,
    });
    const advisor = new JevAdvisor(client);
    const first = await advisor.advise(sampleState(), candidates());
    expect(first.degraded).toBe(true);
    expect(first.reason).toBe('restricted_model');
    expect(script.calls).toHaveLength(1);

    const outcome = await chooseAction({
      state: sampleState(),
      legalActions: [{ type: 'move', moveIndex: 1 }, { type: 'switch', switchIndex: 2 }],
      search: {
        scoreActions: async () => [
          { action: { type: 'move', moveIndex: 1 }, searchScore: 5 },
          { action: { type: 'switch', switchIndex: 2 }, searchScore: 1 },
        ],
      },
      advisor,
      config: { mode: 'prior', priorWeight: 1, tieEpsilon: 0.05, topK: 8 },
    });
    expect(outcome.source).toBe('search');
    expect(outcome.degraded).toBe(true);
    expect(outcome.action).toEqual({ type: 'move', moveIndex: 1 });
    expect(script.calls).toHaveLength(1);
    expect(logs.filter(line => line.includes('RestrictedModelsError'))).toHaveLength(1);
    resetRestrictionLatch();
  });

  it('degrades to an empty assessment when the call times out', async () => {
    resetRestrictionLatch();
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    const script = scriptedFetch([timeout]);
    const client = new GatewayClient({
      apiKey: KEY,
      fetchImpl: script.fetch,
      log: () => {},
      maxRetries: 0,
    });
    const advisor = new JevAdvisor(client);
    const assessment = await advisor.advise(sampleState(), candidates());
    expect(assessment.degraded).toBe(true);
    expect(assessment.reason).toBe('timeout');
    expect(assessment.scores).toEqual({});
  });
});

describe('blend', () => {
  const config = { mode: 'off' as const, priorWeight: 0.15, tieEpsilon: 0.05, topK: 8 };

  it('is off by default and ignores advisor scores', () => {
    const blended = blendCandidates(candidates(), {
      model: JEV_MODEL_ID,
      scores: { a0: 0, a1: 1 },
      probabilities: { a0: 0, a1: 1 },
      booleans: {},
      degraded: false,
      latencyMs: 1,
      costUsd: 0,
    }, config);
    expect(blended.source).toBe('search');
    expect(blended.ranked[0].id).toBe('a0');
    expect(blended.degraded).toBe(false);
  });

  it('uses the advisor as a prior when enabled', () => {
    const blended = blendCandidates(candidates(), {
      model: JEV_MODEL_ID,
      scores: { a0: 0, a1: 1 },
      probabilities: { a0: 0, a1: 1 },
      booleans: {},
      degraded: false,
      latencyMs: 1,
      costUsd: 0,
    }, { ...config, mode: 'prior', priorWeight: 1 });
    expect(blended.source).toBe('prior');
    expect(blended.ranked[0].id).toBe('a1');
  });

  it('uses the advisor only to break near-ties', () => {
    const blended = blendCandidates(candidates(), {
      model: JEV_MODEL_ID,
      scores: { a0: 0.2, a1: 0.9 },
      probabilities: { a0: 0.1, a1: 0.9 },
      booleans: {},
      degraded: false,
      latencyMs: 1,
      costUsd: 0,
    }, { ...config, mode: 'tiebreaker', tieEpsilon: 0.05 });
    expect(blended.source).toBe('tiebreaker');
    expect(blended.ranked[0].id).toBe('a1');
  });

  it('keeps a clear search lead when the tie window is smaller than the gap', () => {
    const blended = blendCandidates(candidates(), {
      model: JEV_MODEL_ID,
      scores: { a0: 0, a1: 1 },
      probabilities: { a0: 0, a1: 1 },
      booleans: {},
      degraded: false,
      latencyMs: 1,
      costUsd: 0,
    }, { ...config, mode: 'tiebreaker', tieEpsilon: 0.01 });
    expect(blended.ranked[0].id).toBe('a0');
  });

  it('falls back to pure search when the advisor degrades', () => {
    const blended = blendCandidates(candidates(), {
      model: JEV_MODEL_ID,
      scores: {},
      probabilities: {},
      booleans: {},
      degraded: true,
      reason: 'timeout',
      latencyMs: 1,
      costUsd: 0,
    }, { ...config, mode: 'prior' });
    expect(blended.source).toBe('search');
    expect(blended.degraded).toBe(true);
    expect(blended.ranked[0].action).toEqual({ type: 'move', moveIndex: 1 });
  });

  it('does not call the advisor when the bot flag is off', async () => {
    let called = false;
    const advisor = {
      advise: async () => {
        called = true;
        throw new Error('should not be called');
      },
      adviseFromState: async () => {
        called = true;
        throw new Error('should not be called');
      },
    } as unknown as JevAdvisor;
    const outcome = await chooseAction({
      state: sampleState(),
      legalActions: [{ type: 'move', moveIndex: 1 }, { type: 'switch', switchIndex: 2 }],
      search: { scoreActions: async () => [{ action: { type: 'move', moveIndex: 1 }, searchScore: 3 }, { action: { type: 'switch', switchIndex: 2 }, searchScore: 1 }] },
      advisor,
      config: blendConfigForBot({ useLLMPrior: false }),
    });
    expect(outcome.action).toEqual({ type: 'move', moveIndex: 1 });
    expect(outcome.source).toBe('search');
    expect(called).toBe(false);
  });

  it('loads the challenger config as an opt-in prior', () => {
    const experiment = loadJevPriorExperiment();
    expect(experiment.champion.blendMode).toBe('off');
    expect(experiment.champion.useLLMPrior).toBe(false);
    const challenger = challengerBlendConfig(experiment);
    expect(challenger.mode).toBe('prior');
    expect(challenger.priorWeight).toBe(0.15);
    expect(experiment.challenger.degradeToPureSearch).toBe(true);
  });
});

describe('loss reviewer', () => {
  it('formats JSONL logs and writes a hypothesis without applying code', async () => {
    const transcript = formatJsonl([
      JSON.stringify({ turn: 4, message: 'stayed in on a faster threat' }),
      JSON.stringify({ turn: 5, action: { type: 'move', moveIndex: 1 } }),
    ].join('\n'));
    expect(transcript).toContain('Turn 4:');

    const finding = {
      criticalTurn: 4,
      mistakeClass: 'speed-control' as const,
      summary: 'Stayed in against a faster attacker.',
      hypothesis: {
        title: 'Preserve the speed option in the lead',
        rationale: 'The bot traded its only faster Pokemon.',
        expectedEffect: 'Fewer lost endgames when the speed option is still alive.',
        testPlan: 'Gate a challenger that switches out the speed option when the opponent is faster.',
        killCondition: 'Reject if panel Elo does not rise or guardrails fail.',
      },
    };
    const script = scriptedFetch([jsonResponse({
      choices: [{ message: { content: JSON.stringify(finding) } }],
      usage: { prompt_tokens: 50, completion_tokens: 80 },
    })]);
    const client = new GatewayClient({ apiKey: KEY, fetchImpl: script.fetch, log: () => {} });
    const reviewer = new LossReviewer(client, DEFAULT_REVIEWER_MODEL_ID);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-graph-'));
    const db = new GraphDB(path.join(dir, 'graph.db'));
    const result = await reviewer.review(transcript, { db, battleId: 'battle-9', sourcePath: 'games/battle-9.jsonl' });
    expect(result.ok).toBe(true);
    expect(result.model).toBe('spacexai/grok-4.7');
    expect(result.finding?.mistakeClass).toBe('speed-control');
    const node = db.getNode(result.hypothesisId!);
    expect(node?.type).toBe('Hypothesis');
    expect(node?.status).toBe('open');
    expect((node as { metadata?: { autoApplied?: boolean } }).metadata?.autoApplied).toBe(false);
    expect((node as { expected_effect?: string }).expected_effect).toContain('endgames');
    db.close();

    const body = JSON.parse(String(script.calls[0].init?.body));
    expect(body.model).toBe(DEFAULT_REVIEWER_MODEL_ID);
    expect(body.model).not.toBe('anthropic/claude-opus-4.5');
  });

  it('does not write a hypothesis when the model response is not the schema', async () => {
    const script = scriptedFetch([jsonResponse({
      choices: [{ message: { content: 'not json' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })]);
    const client = new GatewayClient({ apiKey: KEY, fetchImpl: script.fetch, log: () => {} });
    const reviewer = new LossReviewer(client, DEFAULT_REVIEWER_MODEL_ID);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-graph-'));
    const db = new GraphDB(path.join(dir, 'graph.db'));
    const result = await reviewer.review('turn 1', { db, battleId: 'bad' });
    expect(result.ok).toBe(false);
    expect(result.hypothesisId).toBeUndefined();
    expect(db.getNodesByType('Hypothesis')).toHaveLength(0);
    db.close();
  });
});

describe('Garchomp vs Levitate Rotom-Wash', () => {
  const fixture = garchompRotomFixture();
  const facts = buildBattleFacts(fixture.state, fixture.candidates, fixture.pools);

  it('puts dex types, Levitate, speed, and calc rolls into the state and the criteria', () => {
    expect(facts.text).toContain('types=Dragon/Ground');
    expect(facts.text).toContain('types=Electric/Water');
    expect(facts.text).toContain('ability=Levitate (known)');
    expect(facts.text).toContain('Garchomp=209');
    expect(facts.text).toContain('Rotom-Wash=193');
    expect(facts.text).toContain('Garchomp moves first');
    expect(facts.text).toContain('hp=70%');
    expect(facts.text).toContain('weather=none');
    expect(facts.text).toContain('hazards opp rocks=true');
    expect(facts.text).toContain('Hydro Pump');
    expect(facts.text).toContain('Skarmory');

    expect(facts.criteria.claw).toContain('type=Dragon');
    expect(facts.criteria.claw).toContain('acc=100');
    expect(facts.criteria.claw).toContain('search=9.50');
    expect(facts.criteria.claw).toContain('damage=101-121');
    expect(facts.criteria.stone).toContain('type=Rock');
    expect(facts.criteria.stone).toContain('acc=80');
    expect(facts.criteria.stone).toContain('search=10');
    expect(facts.criteria.quake).toContain('damage=0');
    expect(facts.criteria.quake).toContain('immune or no effect');
    expect(facts.criteria.dance).toContain('no damage roll');

    const clawExpected = Number(facts.criteria.claw.match(/expectedAfterAccuracy=(\d+)/)?.[1]);
    const stoneExpected = Number(facts.criteria.stone.match(/expectedAfterAccuracy=(\d+)/)?.[1]);
    expect(clawExpected).toBeGreaterThan(stoneExpected);
    expect(facts.text.length).toBeLessThanOrEqual(32_000 * 4);
  });

  it('counts Choice Scarf and a speed boost in the speed stat', () => {
    const base = effectiveSpeed(86, 84, 85, 'Bold', undefined, 0);
    const scarf = effectiveSpeed(86, 84, 85, 'Bold', 'Choice Scarf', 0);
    const boosted = effectiveSpeed(86, 84, 85, 'Bold', 'Choice Scarf', 1);
    expect(base).toBe(193);
    expect(scarf).toBe(Math.floor(193 * 1.5));
    expect(boosted).toBe(Math.floor(Math.floor(193 * 1.5) * 1.5));
  });

  it('tells the loss reviewer to quote the calc and not invent matchups', () => {
    const messages = buildReviewMessages('Turn 4: Stone Edge into Rotom-Wash.', facts.text);
    expect(messages.system).toContain('Do not assert type matchups');
    expect(messages.user).toContain('damage=101-121');
    expect(messages.user).toContain('ability=Levitate (known)');
    expect(messages.user).toContain('CALC');
    expect(capEvaluationState(facts.text)).toBe(facts.text);
  });
});

describe('catalog pricing', () => {
  it('defaults the reviewer to Grok 4.7 and prices Jev from the catalog', () => {
    expect(DEFAULT_REVIEWER_MODEL_ID).toBe('spacexai/grok-4.7');
    expect(estimateCostUsd(JEV_MODEL_ID, 1_000_000, 0)).toBeCloseTo(0.042);
    expect(estimateCostUsd(DEFAULT_REVIEWER_MODEL_ID, 1_000_000, 1_000_000)).toBeCloseTo(8);
  });
});

function sampleSummary() {
  return {
    turn: 3,
    player: 'p1' as const,
    field: { trickRoom: false, screens: {} },
    hazards: {
      my: { stealthRock: false, spikes: 0, toxicSpikes: 0 },
      opponent: { stealthRock: true, spikes: 0, toxicSpikes: 0 },
    },
    myActive: null,
    opponentActive: null,
    myBench: [],
    opponentBench: [],
    teraUsed: { mine: false, opponent: false },
  };
}

function sampleState(): GameState {
  return {
    myTeam: [],
    opponentTeam: [],
    myActive: 0,
    opponentActive: 0,
    turn: 3,
    myTeraUsed: false,
    opponentTeraUsed: false,
    field: { trickRoom: false, screens: {} },
    hazards: sampleSummary().hazards,
    playerId: 'p1',
  };
}
