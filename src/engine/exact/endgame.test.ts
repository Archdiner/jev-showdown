import { Battle } from '@pkmn/sim';
import { EXACT_1PLY_QW, endgameConfig, exactSearch, remainingMons } from './search.js';

function set(species: string, moves: string[]) {
  return { species, moves, ability: 'Pressure', item: '', level: 80 } as any;
}

function battleWith(ours: number, foes: number): Battle {
  const battle = new Battle({ formatid: 'gen9customgame' as any, seed: [1, 2, 3, 4] as any });
  const mine = ['Snorlax', 'Garchomp', 'Pikachu', 'Blissey', 'Dragonite', 'Gengar'].slice(0, ours);
  const theirs = ['Tauros', 'Raichu', 'Gyarados', 'Starmie', 'Alakazam', 'Machamp'].slice(0, foes);
  battle.setPlayer('p1', { name: 'a', team: mine.map(s => set(s, ['tackle', 'bodyslam'])) });
  battle.setPlayer('p2', { name: 'b', team: theirs.map(s => set(s, ['tackle'])) });
  battle.makeChoices('team 1', 'team 1');
  return battle;
}

describe('endgame deepening (opt-in)', () => {
  it('counts unrevealed foes as alive', () => {
    // Revealed-only decision battle: one foe known, five still unseen.
    const battle = battleWith(1, 1);
    expect(remainingMons(battle, 'p1')).toBe(1 + 6);
  });

  it('subtracts fainted foes from the six-mon team', () => {
    const battle = battleWith(2, 2);
    battle.getSide('p2').pokemon[1].fainted = true;
    expect(remainingMons(battle, 'p1')).toBe(2 + 5);
  });

  it('leaves the config untouched when unset or above the threshold', () => {
    const battle = battleWith(6, 6);
    expect(endgameConfig(battle, 'p1', EXACT_1PLY_QW)).toBe(EXACT_1PLY_QW);
    const opted = { ...EXACT_1PLY_QW, endgame: { mons: 3, depth: 2 } };
    expect(endgameConfig(battle, 'p1', opted)).toBe(opted);
  });

  it('deepens once the threshold is reached', () => {
    const battle = battleWith(1, 6);
    for (const mon of battle.getSide('p2').pokemon.slice(1)) mon.fainted = true;
    const opted = { ...EXACT_1PLY_QW, endgame: { mons: 3, depth: 2 } };
    const deep = endgameConfig(battle, 'p1', opted);
    expect(deep.depth).toBe(2);
    expect(deep.rolloutDeadline).toBe(true);
    const trace = exactSearch(battle, 'p1', { ...opted, deadlineMs: Date.now() + 2000 });
    expect(trace.scores.length).toBeGreaterThan(0);
  });
});
