import { describe, expect, it } from '@jest/globals';
import { startRandomBattle, teamsForSeed } from '../engine/exact/battle-utils.js';
import { GatewayClient } from './gateway-client.js';
import { parsePlan, parseStrategist, strategistChoices, strategistDecide } from './strategist.js';

function scripted(plan: string, jevChoice: string): { client: GatewayClient; chats: number[] } {
  const chats = [0];
  const client = new GatewayClient({
    apiKey: 'test-key',
    maxRetries: 0,
    timeoutMs: 1000,
    perTurnLatencyBudgetMs: 1000,
    log: () => {},
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.includes('/evaluate')) {
        const body = JSON.parse(String(init?.body));
        const questions = Object.keys(body.questions as Record<string, { instructions: string }>);
        const valueKey = questions.find(name => name.startsWith('value_') && body.questions[name].instructions.includes(jevChoice));
        const answers: Record<string, { score?: number; probability?: number }> = {
          matchup: { score: 3 },
          opponentWillSwitch: { probability: 0.2 },
        };
        for (const name of questions) {
          if (name.startsWith('value_')) answers[name] = { score: name === valueKey ? 4 : 1 };
          if (name.startsWith('risk_')) answers[name] = { score: 0 };
        }
        return new Response(JSON.stringify({ model: 'typesafe-ai/jev', answers }), { status: 200 });
      }
      chats[0] += 1;
      const sent = JSON.parse(String(init?.body));
      expect(sent.reasoning_effort).toBe('none');
      expect(sent.max_tokens).toBe(120);
      return new Response(JSON.stringify({
        choices: [{ message: { content: plan } }],
        usage: { prompt_tokens: 40, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 0 } },
      }), { status: 200 });
    },
  });
  return { client, chats };
}

describe('strategist', () => {
  it('parses a compact plan and still accepts a listed action from older JSON', () => {
    const teams = teamsForSeed(3);
    const battle = startRandomBattle(teams.p1, teams.p2, 3);
    const legal = strategistChoices(battle, 'p1');
    expect(legal.some(choice => choice.startsWith('switch '))).toBe(true);
    const plan = parsePlan(JSON.stringify({
      win: 'keep the fastest mon',
      keep: ['fast'],
      sack: [],
      threat: 'the boosted attacker',
      note: 'do not loop switches',
    }));
    expect(plan?.winCondition).toBe('keep the fastest mon');
    expect(plan?.threats).toEqual(['the boosted attacker']);
    expect(parsePlan('not json')).toBeNull();
    const switchChoice = legal.find(choice => choice.startsWith('switch '))!;
    expect(parseStrategist(JSON.stringify({
      action: switchChoice,
      confidence: 0.4,
      reasoning: 'switch',
      plan: { winCondition: 'w', preserve: [], sacks: [], threats: [], notes: 'n' },
    }), legal)?.action).toBe(switchChoice);
    expect(parseStrategist(JSON.stringify({ action: 'move 99', confidence: 1, reasoning: '', plan: { winCondition: 'w' } }), legal)).toBeNull();
  });

  it('calls Grok once for the plan and reuses it on the next quiet turn', async () => {
    const teams = teamsForSeed(3);
    const battle = startRandomBattle(teams.p1, teams.p2, 3);
    const legal = strategistChoices(battle, 'p1');
    const move = legal.find(choice => choice.startsWith('move ')) ?? legal[0];
    const script = scripted(JSON.stringify({
      win: 'keep the fastest mon',
      keep: ['fast'],
      sack: [],
      threat: 'the active attacker',
      note: 'chip then preserve',
    }), move);
    const first = await strategistDecide({
      battle,
      side: 'p1',
      client: script.client,
      params: { vetoMargin: 100, switchCost: 0 },
    });
    expect(first.grok).toBe('called');
    expect(first.critical).toBe(true);
    expect(first.plan?.winCondition).toBe('keep the fastest mon');
    expect(legal).toContain(first.choice);
    expect(script.chats[0]).toBe(1);

    const second = await strategistDecide({
      battle,
      side: 'p1',
      client: script.client,
      params: { vetoMargin: 100, switchCost: 0 },
    });
    expect(second.grok).toBe('cached');
    expect(second.critical).toBe(false);
    expect(script.chats[0]).toBe(1);
    expect(legal).toContain(second.choice);
  });

  it('no-key harness falls back to search and the veto', async () => {
    const saved = process.env.VERCEL_AI_GATEWAY_KEY;
    const savedAlt = process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_AI_GATEWAY_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    try {
      const teams = teamsForSeed(5);
      const battle = startRandomBattle(teams.p1, teams.p2, 5);
      const decision = await strategistDecide({ battle, side: 'p1', timeoutMs: 50 });
      expect(decision.grok).toBe('error');
      expect(decision.error).toBe('missing_api_key');
      expect(decision.fallback).toBe(true);
      expect(strategistChoices(battle, 'p1')).toContain(decision.choice);
    } finally {
      if (saved !== undefined) process.env.VERCEL_AI_GATEWAY_KEY = saved;
      if (savedAlt !== undefined) process.env.AI_GATEWAY_API_KEY = savedAlt;
    }
  });

  it('falls back when the plan call times out', async () => {
    const teams = teamsForSeed(5);
    const battle = startRandomBattle(teams.p1, teams.p2, 5);
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
    const timed = await strategistDecide({ battle, side: 'p2', client: hanging, timeoutMs: 80 });
    expect(timed.grok).toBe('timeout');
    expect(timed.fallback).toBe(true);
    expect(strategistChoices(battle, 'p2')).toContain(timed.choice);
  });
});
