import { describe, expect, it } from '@jest/globals';
import { criticalReasons, type BoardSnap } from './critical-turn.js';

const cfg = { hpSwing: 0.4, endgameMons: 2 };

function board(patch: Partial<BoardSnap> = {}): BoardSnap {
  return {
    turn: 4,
    ourSpecies: 'A',
    foeSpecies: 'B',
    ourHp: 0.8,
    foeHp: 0.8,
    ourAlive: 5,
    foeAlive: 5,
    canTera: true,
    ...patch,
  };
}

describe('critical turns', () => {
  it('starts the game, then stays quiet until the board changes', () => {
    expect(criticalReasons(null, board({ turn: 1 }), cfg)).toEqual(['start']);
    const prev = board({ turn: 1, canTera: true });
    expect(criticalReasons(prev, board({ turn: 2 }), cfg)).toEqual([]);
  });

  it('fires on a new foe, a KO, a big HP swing, tera becoming legal, and the endgame transition', () => {
    const prev = board();
    expect(criticalReasons(prev, board({ foeSpecies: 'C' }), cfg)).toContain('new-foe');
    expect(criticalReasons(prev, board({ foeAlive: 4 }), cfg)).toContain('ko');
    expect(criticalReasons(prev, board({ foeHp: 0.3 }), cfg)).toContain('hp-swing');
    expect(criticalReasons(prev, board({ foeHp: 0.7 }), cfg)).toEqual([]);
    expect(criticalReasons(board({ canTera: false }), board({ canTera: true }), cfg)).toContain('tera');
    expect(criticalReasons(prev, board({ canTera: true }), cfg)).not.toContain('tera');
    expect(criticalReasons(prev, board({ foeAlive: 2 }), cfg)).toContain('endgame');
    expect(criticalReasons(board({ foeAlive: 2 }), board({ turn: 8, foeAlive: 2 }), cfg)).not.toContain('endgame');
  });
});
