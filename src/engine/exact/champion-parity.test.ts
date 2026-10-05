import { legalChoices, safeChoose, startRandomBattle, teamsForSeed } from './battle-utils.js';
import { EXACT_1PLY, exactSearch } from './search.js';

/** Choices of exactSearch(EXACT_1PLY) on origin/main c105e48, seeds 1–8, four turns. */
const GOLDEN: Array<{ seed: number; turns: Array<{ p1?: string; p2?: string }> }> = [
  { seed: 1, turns: [{ p1: 'switch 5', p2: 'move 2' }, { p1: 'switch 2', p2: 'switch 5' }, { p1: 'move 4', p2: 'move 3' }, { p1: 'switch 4', p2: 'switch 2' }] },
  { seed: 2, turns: [{ p1: 'switch 6', p2: 'move 3' }, { p1: 'move 1', p2: 'move 1' }, { p1: 'move 1', p2: 'switch 2' }, { p1: 'switch 6', p2: 'move 2' }] },
  { seed: 3, turns: [{ p1: 'move 2', p2: 'switch 6' }, { p1: 'switch 2', p2: 'move 1' }, { p1: 'switch 6', p2: 'move 4' }, { p1: 'switch 6', p2: 'move 1' }] },
  { seed: 4, turns: [{ p1: 'move 2', p2: 'switch 3' }, { p1: 'switch 6', p2: 'move 3' }, { p1: 'switch 6', p2: 'move 1' }, { p1: 'switch 6', p2: 'move 3' }] },
  { seed: 5, turns: [{ p1: 'move 2', p2: 'move 1' }, { p1: 'move 2', p2: 'switch 6' }, { p1: 'move 1', p2: 'move 2' }, { p1: 'move 1', p2: 'switch 3' }] },
  { seed: 6, turns: [{ p1: 'move 2', p2: 'move 1' }, { p2: 'switch 6' }, { p1: 'switch 4', p2: 'move 2' }, { p1: 'move 4', p2: 'switch 4' }] },
  { seed: 7, turns: [{ p1: 'move 1', p2: 'switch 5' }, { p1: 'switch 3', p2: 'move 4' }, { p1: 'switch 2', p2: 'move 3' }, { p1: 'switch 5', p2: 'move 1' }] },
  { seed: 8, turns: [{ p1: 'move 3', p2: 'move 4' }, { p1: 'move 3', p2: 'switch 4' }, { p1: 'switch 5', p2: 'move 1' }, { p1: 'switch 4', p2: 'move 2' }] },
];

function championGames(): typeof GOLDEN {
  const games: typeof GOLDEN = [];
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const teams = teamsForSeed(seed);
    const battle = startRandomBattle(teams.p1, teams.p2, seed);
    const turns: Array<{ p1?: string; p2?: string }> = [];
    let steps = 0;
    while (!battle.ended && steps < 4) {
      steps += 1;
      const row: { p1?: string; p2?: string } = {};
      for (const side of ['p1', 'p2'] as const) {
        const legal = legalChoices(battle, side);
        if (legal.length === 0 || battle.ended) continue;
        if (legal[0] === 'default') {
          battle.choose(side, 'default');
          row[side] = 'default';
          continue;
        }
        const choice = exactSearch(battle, side, EXACT_1PLY).choice;
        row[side] = choice;
        safeChoose(battle, side, choice);
      }
      turns.push(row);
    }
    games.push({ seed, turns });
  }
  return games;
}

describe('champion parity', () => {
  test('EXACT_1PLY matches main on a fixed seed set', () => {
    expect(JSON.stringify(EXACT_1PLY)).toBe(JSON.stringify({
      depth: 1,
      opponentModel: 'max-damage',
      evalMode: 'hp',
      errorAsLoss: false,
      samples: 8,
    }));
    expect(EXACT_1PLY).not.toHaveProperty('tera');
    expect(EXACT_1PLY).not.toHaveProperty('progress');
    expect(EXACT_1PLY).not.toHaveProperty('foePrior');
    expect(championGames()).toEqual(GOLDEN);
  }, 120_000);
});
