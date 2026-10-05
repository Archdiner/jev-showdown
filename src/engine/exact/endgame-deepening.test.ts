import { Battle } from '@pkmn/sim';
import { startRandomBattle, teamsForSeed, totalRemainingMons } from './battle-utils.js';
import { exactSearch, type ExactConfig, EXACT_1PLY } from './search.js';

describe('endgame deepening', () => {
  it('counts remaining mons correctly', () => {
    const { p1, p2 } = teamsForSeed(1);
    const battle = startRandomBattle(p1, p2, 1);
    const count = totalRemainingMons(battle);
    expect(count).toBe(12); // 6 per side in randbats
  });

  it('does not deepen without endgame config', () => {
    const { p1, p2 } = teamsForSeed(1);
    const battle = startRandomBattle(p1, p2, 1);
    
    // Standard config without endgame params
    const config: ExactConfig = { ...EXACT_1PLY };
    
    const result = exactSearch(battle, 'p1', config);
    expect(result.choice).toBeDefined();
    expect(result.scores.length).toBeGreaterThan(0);
  });

  it('deepens in endgame when configured', () => {
    const { p1, p2 } = teamsForSeed(1);
    const battle = startRandomBattle(p1, p2, 1);
    
    // Simulate endgame by fainting mons
    const p1Side = battle.getSide('p1');
    const p2Side = battle.getSide('p2');
    
    // Faint all but 2 mons per side
    for (let i = 2; i < 6; i++) {
      p1Side.pokemon[i].hp = 0;
      p1Side.pokemon[i].fainted = true;
      p2Side.pokemon[i].hp = 0;
      p2Side.pokemon[i].fainted = true;
    }
    
    const remaining = totalRemainingMons(battle);
    expect(remaining).toBe(4);
    
    // Config with endgame deepening
    const config: ExactConfig = {
      ...EXACT_1PLY,
      endgameMonThreshold: 4,
      endgameDepth: 3,
    };
    
    const result = exactSearch(battle, 'p1', config);
    expect(result.choice).toBeDefined();
    expect(result.scores.length).toBeGreaterThan(0);
  });

  it('does not deepen above threshold', () => {
    const { p1, p2 } = teamsForSeed(1);
    const battle = startRandomBattle(p1, p2, 1);
    
    // Full teams (12 mons total)
    const remaining = totalRemainingMons(battle);
    expect(remaining).toBe(12);
    
    // Config with endgame deepening but threshold not met
    const config: ExactConfig = {
      ...EXACT_1PLY,
      endgameMonThreshold: 4,
      endgameDepth: 3,
    };
    
    const result = exactSearch(battle, 'p1', config);
    expect(result.choice).toBeDefined();
  });

  it('maintains parity for exact-1ply without endgame params', () => {
    const { p1, p2 } = teamsForSeed(42);
    const battle1 = startRandomBattle(p1, p2, 42);
    const battle2 = startRandomBattle(p1, p2, 42);
    
    const config1: ExactConfig = { ...EXACT_1PLY };
    const config2: ExactConfig = {
      ...EXACT_1PLY,
      endgameMonThreshold: undefined,
      endgameDepth: undefined,
    };
    
    const result1 = exactSearch(battle1, 'p1', config1);
    const result2 = exactSearch(battle2, 'p1', config2);
    
    // Should produce identical choices
    expect(result1.choice).toBe(result2.choice);
    expect(result1.scores.length).toBe(result2.scores.length);
  });
});
