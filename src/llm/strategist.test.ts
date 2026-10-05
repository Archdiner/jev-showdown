import { describe, expect, it } from '@jest/globals';
import { startRandomBattle, teamsForSeed } from '../engine/exact/battle-utils.js';
import { EXACT_1PLY, exactSearch } from '../engine/exact/search.js';
import { GatewayClient } from './gateway-client.js';
import { parseStrategist, strategistChoices, strategistDecide } from './strategist.js';

function scripted(body: unknown, status = 200): GatewayClient {
  return new GatewayClient({
    apiKey: 'test-key',
    maxRetries: 0,
    timeoutMs: 1000,
    perTurnLatencyBudgetMs: 1000,
    log: () => {},
    fetchImpl: async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  });
}

function chatBody(action: string) {
  return {
    choices: [{
      message: {
        content: JSON.stringify({
          action,
          confidence: 0.7,
          reasoning: 'the brief supports this',
          plan: { winCondition: 'keep the fastest mon', preserve: ['fast'], sacks: [], threats: [], notes: '' },
        }),
      },
    }],
  };
}

describe('strategist', () => {
  it('offers switches and accepts only a listed action', () => {
    const teams = teamsForSeed(3);
    const battle = startRandomBattle(teams.p1, teams.p2, 3);
    const legal = strategistChoices(battle, 'p1');
    expect(legal.some(choice => choice.startsWith('switch '))).toBe(true);
    expect(parseStrategist(JSON.stringify({ action: 'move 99', confidence: 1, reasoning: '', plan: {} }), legal)).toBeNull();
    const switchChoice = legal.find(choice => choice.startsWith('switch '));
    expect(parseStrategist(JSON.stringify({ action: switchChoice, confidence: 0.4, reasoning: 'switch', plan: { winCondition: 'w' } }), legal)?.action).toBe(switchChoice);
  });

  it('no-key harness falls back to exact 1-ply search', async () => {
    const saved = process.env.VERCEL_AI_GATEWAY_KEY;
    const savedAlt = process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_AI_GATEWAY_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    try {
      const teams = teamsForSeed(5);
      const battle = startRandomBattle(teams.p1, teams.p2, 5);
      const decision = await strategistDecide({ battle, side: 'p1', timeoutMs: 50 });
      expect(decision.source).toBe('search');
      expect(decision.error).toBe('missing_api_key');
      expect(decision.choice).toBe(exactSearch(battle, 'p1', EXACT_1PLY).choice);
    } finally {
      if (saved !== undefined) process.env.VERCEL_AI_GATEWAY_KEY = saved;
      if (savedAlt !== undefined) process.env.AI_GATEWAY_API_KEY = savedAlt;
    }
  });

  it('plays a legal switch from Grok JSON', async () => {
    const teams = teamsForSeed(3);
    const battle = startRandomBattle(teams.p1, teams.p2, 3);
    const legal = strategistChoices(battle, 'p1');
    const switchChoice = legal.find(choice => choice.startsWith('switch '));
    expect(switchChoice).toBeTruthy();
    const decision = await strategistDecide({ battle, side: 'p1', client: scripted(chatBody(switchChoice!)) });
    expect(decision.source).toBe('grok');
    expect(decision.choice).toBe(switchChoice);
    expect(decision.plan?.winCondition).toBe('keep the fastest mon');
  });

  it('falls back when the action is illegal or the call times out', async () => {
    const teams = teamsForSeed(5);
    const battle = startRandomBattle(teams.p1, teams.p2, 5);
    const illegal = await strategistDecide({ battle, side: 'p1', client: scripted(chatBody('move 99')) });
    expect(illegal.source).toBe('search');
    expect(illegal.error).toBe('unusable_plan');
    expect(illegal.choice).toBe(exactSearch(battle, 'p1', EXACT_1PLY).choice);

    const hanging = new GatewayClient({
      apiKey: 'test-key',
      maxRetries: 0,
      timeoutMs: 30,
      perTurnLatencyBudgetMs: 30,
      log: () => {},
      fetchImpl: (_input, init) => new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
      }),
    });
    const timed = await strategistDecide({ battle, side: 'p2', client: hanging });
    expect(timed.source).toBe('search');
    expect(timed.choice).toBe(exactSearch(battle, 'p2', EXACT_1PLY).choice);
  });
});
