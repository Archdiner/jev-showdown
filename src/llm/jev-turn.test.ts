import { describe, expect, it } from '@jest/globals';
import { startRandomBattle, teamsForSeed } from '../engine/exact/battle-utils.js';
import { EXACT_1PLY, exactSearch } from '../engine/exact/search.js';
import { GatewayClient } from './gateway-client.js';
import { jevChoices, jevDecide, scoreWithJev } from './jev-turn.js';

function answered(choice: string, value: number, risk: number): GatewayClient {
  const legalHint = choice;
  return new GatewayClient({
    apiKey: 'test-key',
    maxRetries: 0,
    timeoutMs: 1000,
    perTurnLatencyBudgetMs: 1000,
    log: () => {},
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const questions = Object.keys(body.questions as Record<string, unknown>);
      const valueKey = questions.find(name => name.startsWith('value_') && body.questions[name].instructions.includes(legalHint));
      const riskKey = valueKey?.replace('value_', 'risk_');
      const answers: Record<string, { score?: number; probability?: number }> = {
        matchup: { score: 3 },
        opponentWillSwitch: { probability: 0.4 },
      };
      if (valueKey) answers[valueKey] = { score: value };
      if (riskKey) answers[riskKey] = { score: risk };
      return new Response(JSON.stringify({ model: 'typesafe-ai/jev', answers }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
}

describe('jev turn score', () => {
  it('scores switches as well as moves', () => {
    const teams = teamsForSeed(4);
    const battle = startRandomBattle(teams.p1, teams.p2, 4);
    expect(jevChoices(battle, 'p1').some(choice => choice.startsWith('switch '))).toBe(true);
  });

  it('no-key harness falls back to exact 1-ply search', async () => {
    const saved = process.env.VERCEL_AI_GATEWAY_KEY;
    const savedAlt = process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_AI_GATEWAY_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    try {
      const teams = teamsForSeed(6);
      const battle = startRandomBattle(teams.p1, teams.p2, 6);
      const scored = await scoreWithJev({ battle, side: 'p1', timeoutMs: 50 });
      expect(scored.degraded).toBe(true);
      expect(scored.error).toBe('missing_api_key');
      const decision = await jevDecide({ battle, side: 'p1', timeoutMs: 50 });
      expect(decision.source).toBe('search');
      expect(decision.choice).toBe(exactSearch(battle, 'p1', EXACT_1PLY).choice);
    } finally {
      if (saved !== undefined) process.env.VERCEL_AI_GATEWAY_KEY = saved;
      if (savedAlt !== undefined) process.env.AI_GATEWAY_API_KEY = savedAlt;
    }
  });

  it('picks the higher value minus risk', async () => {
    const teams = teamsForSeed(4);
    const battle = startRandomBattle(teams.p1, teams.p2, 4);
    const switchChoice = jevChoices(battle, 'p1').find(choice => choice.startsWith('switch '));
    expect(switchChoice).toBeTruthy();
    const decision = await jevDecide({
      battle,
      side: 'p1',
      client: answered(switchChoice!, 4, 0),
    });
    expect(decision.source).toBe('jev');
    expect(decision.choice).toBe(switchChoice);
    expect(decision.switchProbability).toBeCloseTo(0.4);
    expect(decision.matchup).toBeCloseTo(0.75);
  });
});
