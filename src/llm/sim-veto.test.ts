import { describe, expect, it } from '@jest/globals';
import { startRandomBattle, teamsForSeed } from '../engine/exact/battle-utils.js';
import { simVeto, verifyChoices, vetoChoice } from './sim-veto.js';

describe('sim veto', () => {
  it('replaces a proposal that trails the sim line', () => {
    const vetoed = vetoChoice({
      proposal: 'move 2',
      scores: [
        { choice: 'switch 3', score: 4 },
        { choice: 'move 2', score: 1 },
      ],
      margin: 1,
      legal: ['switch 3', 'move 2'],
    });
    expect(vetoed.choice).toBe('switch 3');
    expect(vetoed.veto?.gap).toBe(3);

    const kept = vetoChoice({
      proposal: 'move 2',
      scores: [
        { choice: 'switch 3', score: 1.2 },
        { choice: 'move 2', score: 1 },
      ],
      margin: 1,
      legal: ['switch 3', 'move 2'],
    });
    expect(kept.choice).toBe('move 2');
    expect(kept.veto).toBeNull();
  });

  it('no-key harness scores switches on generated battles', () => {
    delete process.env.VERCEL_AI_GATEWAY_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    for (const seed of [2, 5, 9]) {
      const teams = teamsForSeed(seed);
      const battle = startRandomBattle(teams.p1, teams.p2, seed);
      const scores = verifyChoices(battle, 'p1');
      expect(scores.some(row => row.choice.startsWith('switch '))).toBe(true);
      expect(scores.every(row => Number.isFinite(row.score))).toBe(true);
      const decided = simVeto(battle, 'p1', 1);
      expect(scores.map(row => row.choice)).toContain(decided.choice);
    }
  });
});
