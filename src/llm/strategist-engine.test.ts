import { describe, expect, it } from '@jest/globals';
import { buildBot } from '../config/bot.js';
import { loadConfig } from '../config/load.js';
import { legalChoices, startRandomBattle, teamsForSeed } from '../engine/exact/battle-utils.js';

describe('strategist engine', () => {
  it('is a buildBot config whose search id is strategist', () => {
    const loaded = loadConfig('configs/strategist.yaml');
    expect(loaded.config.search.id).toBe('strategist');
    expect(loaded.config.name).toBe('strategist');
  });

  it('no-key harness plays a legal action through buildBot', async () => {
    const saved = process.env.VERCEL_AI_GATEWAY_KEY;
    const savedAlt = process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_AI_GATEWAY_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    try {
      const teams = teamsForSeed(8);
      const battle = startRandomBattle(teams.p1, teams.p2, 8);
      const bot = buildBot('configs/strategist.yaml', 'local');
      const decision = await bot.decide({ battle, side: 'p1', gameId: 'smoke', seed: 8 });
      const legal = legalChoices(battle, 'p1');
      expect(legal).toContain(decision.choice);
      expect(decision.layerIds.search).toBe('strategist');
      expect(decision.configId).toBe(loadConfig('configs/strategist.yaml').configId);
    } finally {
      if (saved !== undefined) process.env.VERCEL_AI_GATEWAY_KEY = saved;
      if (savedAlt !== undefined) process.env.AI_GATEWAY_API_KEY = savedAlt;
    }
  });
});
