import { Battle } from '@pkmn/sim';
import { solveZeroSum } from './matrix-solve.js';
import { EXACT_1PLY_QW, exactSearch } from './search.js';

describe('zero-sum matrix solve (opt-in replySolve)', () => {
  it('finds the uniform mix for rock-paper-scissors', () => {
    const rps = [[0, -1, 1], [1, 0, -1], [-1, 1, 0]];
    const out = solveZeroSum(rps, 2000);
    for (const p of [...out.rows, ...out.cols]) expect(p).toBeCloseTo(1 / 3, 1);
    expect(out.value).toBeCloseTo(0, 1);
  });

  it('plays a dominant row and the foe the column that hurts it most', () => {
    const out = solveZeroSum([[5, 2], [1, 0]], 500);
    expect(out.rows[0]).toBeGreaterThan(0.95);
    expect(out.cols[1]).toBeGreaterThan(0.95);
    expect(out.value).toBeCloseTo(2, 1);
  });

  it('matching pennies with unequal stakes', () => {
    // Row mix p on row 0: 3p - (1-p) = -p + (1-p) => p = 1/3.
    const out = solveZeroSum([[3, -1], [-1, 1]], 4000);
    expect(out.rows[0]).toBeCloseTo(1 / 3, 1);
  });

  it('exactSearch with replySolve returns a legal own choice', () => {
    const battle = new Battle({ formatid: 'gen9customgame' as any, seed: [1, 2, 3, 4] as any });
    const set = (species: string, moves: string[]) => ({ species, moves, ability: 'Pressure', item: '', level: 80 } as any);
    battle.setPlayer('p1', { name: 'a', team: [set('Snorlax', ['bodyslam', 'earthquake']), set('Garchomp', ['earthquake'])] });
    battle.setPlayer('p2', { name: 'b', team: [set('Tauros', ['bodyslam', 'closecombat']), set('Gyarados', ['waterfall'])] });
    battle.makeChoices('team 1', 'team 1');
    const trace = exactSearch(battle, 'p1', {
      ...EXACT_1PLY_QW,
      replySolve: { maxReplies: 4, samples: 2, nashWeight: 1, iterations: 200 },
    });
    expect(['move 1', 'move 2', 'switch 2', 'move 1 terastallize', 'move 2 terastallize']).toContain(trace.choice);
    expect(trace.scores.length).toBeGreaterThan(1);
  });
});
