import { describe, it, expect } from '@jest/globals';
import { Evaluator } from './evaluator.js';
import { GameState } from '../types/index.js';

describe('Evaluator', () => {
  const createTestState = (): GameState => ({
    myTeam: [],
    opponentTeam: [],
    myActive: 0,
    opponentActive: 0,
    turn: 1,
    myTeraUsed: false,
    opponentTeraUsed: false,
    field: {
      trickRoom: false,
      screens: {},
    },
    hazards: {
      my: { stealthRock: false, spikes: 0, toxicSpikes: 0 },
      opponent: { stealthRock: false, spikes: 0, toxicSpikes: 0 },
    },
  });

  it('should evaluate a game state', () => {
    const evaluator = new Evaluator();
    const state = createTestState();
    
    const result = evaluator.evaluate(state);
    
    expect(result.score).toBeDefined();
    expect(result.breakdown).toBeDefined();
  });

  it('should favor having hazards on opponent side', () => {
    const evaluator = new Evaluator();
    const state1 = createTestState();
    const state2 = createTestState();
    
    state2.hazards.opponent.stealthRock = true;
    
    const result1 = evaluator.evaluate(state1);
    const result2 = evaluator.evaluate(state2);
    
    expect(result2.score).toBeGreaterThan(result1.score);
  });

  it('should update weights', () => {
    const evaluator = new Evaluator();
    const oldWeights = evaluator.getWeights();
    
    evaluator.updateWeights({ material: 150 });
    
    const newWeights = evaluator.getWeights();
    expect(newWeights.material).toBe(150);
    expect(newWeights.hp).toBe(oldWeights.hp);
  });
});
