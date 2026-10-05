import { describe, expect, it } from '@jest/globals';
import { buildBot, playedChoice } from '../config/bot.js';
import { loadConfig } from '../config/load.js';
import { choiceAccepted, legalChoices, startRandomBattle, teamsForSeed } from '../engine/exact/battle-utils.js';

describe('strategist engine', () => {
  it('is a buildBot config whose search id is strategist', () => {
    const loaded = loadConfig('configs/strategist.yaml');
    expect(loaded.config.search.id).toBe('strategist');
    expect(loaded.config.name).toBe('strategist');
    const params = loaded.config.search.params as { planMode?: string; reasoningEffort?: string; timeBudgetMs?: number };
    expect(params.planMode).toBe('critical');
    expect(params.reasoningEffort).toBe('none');
    expect(params.timeBudgetMs).toBe(14000);
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
      expect(choiceAccepted(battle, 'p1', decision.choice)).toBe(true);
      expect(decision.layerIds.search).toBe('strategist');
      expect(decision.configId).toBe(loadConfig('configs/strategist.yaml').configId);
    } finally {
      if (saved !== undefined) process.env.VERCEL_AI_GATEWAY_KEY = saved;
      if (savedAlt !== undefined) process.env.AI_GATEWAY_API_KEY = savedAlt;
    }
  });

  it('plays a committed Terastallize line instead of the switch a re-rank would pick', () => {
    const teams = teamsForSeed(4);
    const battle = startRandomBattle(teams.p1, teams.p2, 4);
    battle.getSide('p1').activeRequest = {
      active: [{
        moves: [{ disabled: false }, { disabled: false }, { disabled: false }, { disabled: false }],
        canTerastallize: 'Fire',
      }],
    } as never;
    expect(legalChoices(battle, 'p1')).not.toContain('move 1 terastallize');
    expect(choiceAccepted(battle, 'p1', 'move 1 terastallize')).toBe(true);
    expect(playedChoice(battle, 'p1', { choice: 'move 1 terastallize', committed: true }, 'switch 2')).toBe('move 1 terastallize');
    expect(playedChoice(battle, 'p1', { choice: 'move 1 terastallize' }, 'switch 2')).toBe('switch 2');
  });
});
