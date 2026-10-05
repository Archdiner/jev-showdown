import { Battle } from '@pkmn/sim';
import {
  applyStatsPrior,
  placeholderSets,
  rolePosterior,
  setUsageStatsForTests,
} from './stats-prior.js';

const TABLE = {
  Garchomp: {
    level: 74,
    roles: {
      'Fast Support': {
        weight: 0.5,
        abilities: { 'Rough Skin': 1 },
        items: { 'Rocky Helmet': 1 },
        moves: { Earthquake: 1, Outrage: 1, 'Dragon Tail': 0.7, Spikes: 0.7, 'Stealth Rock': 0.6 },
      },
      'Setup Sweeper': {
        weight: 0.5,
        abilities: { 'Rough Skin': 1 },
        items: { 'Loaded Dice': 1 },
        moves: { Earthquake: 1, 'Scale Shot': 1, 'Swords Dance': 1, 'Fire Fang': 0.5, 'Iron Head': 0.4 },
      },
    },
  },
  Pikachu: {
    level: 93,
    roles: {
      'Fast Attacker': {
        weight: 1,
        abilities: { Static: 0.4, Lightningrod: 0.6 },
        items: { 'Light Ball': 1 },
        moves: { 'Volt Tackle': 1, 'Knock Off': 1, 'Surf': 0.8, 'Play Rough': 0.7 },
      },
    },
  },
  Snorlax: {
    level: 84,
    roles: {
      'Bulky Setup': {
        weight: 1,
        abilities: { 'Thick Fat': 1 },
        items: { Leftovers: 1 },
        moves: { 'Body Slam': 1, 'Earthquake': 0.8, 'Curse': 1, 'Rest': 1 },
      },
    },
  },
} as any;

function battleWith(foe: string, foeMoves: string[]): Battle {
  const battle = new Battle({ formatid: 'gen9customgame' as any, seed: [1, 2, 3, 4] as any });
  battle.setPlayer('p1', { name: 'a', team: [{ species: 'Snorlax', moves: ['bodyslam'], ability: 'Thick Fat', item: '', level: 80 } as any] });
  battle.setPlayer('p2', { name: 'b', team: [{ species: foe, moves: foeMoves, ability: 'Rough Skin', item: '', level: 74 } as any] });
  return battle;
}

describe('stats prior', () => {
  beforeAll(() => setUsageStatsForTests(TABLE));
  afterAll(() => setUsageStatsForTests(null));

  test('a revealed role move picks that role', () => {
    const post = rolePosterior(TABLE.Garchomp, { moves: ['scaleshot'] });
    expect(post[0].role).toBe('Setup Sweeper');
    expect(post[0].prob).toBeCloseTo(1);
  });

  test('fills hidden item and damaging moves from the posterior, keeps revealed', () => {
    const battle = battleWith('Garchomp', ['scaleshot']);
    applyStatsPrior(battle, 'p1', [{ itemUnknown: true, abilityUnknown: false }], { items: true, abilities: true });
    const mon = battle.p2.pokemon[0] as any;
    expect(mon.item).toBe('loadeddice');
    const ids = mon.moveSlots.map((slot: any) => slot.id);
    expect(ids[0]).toBe('scaleshot');
    expect(ids).toContain('earthquake');
    expect(ids).not.toContain('swordsdance');
  });

  test('never overwrites an item the protocol showed as gone', () => {
    const battle = battleWith('Garchomp', ['scaleshot']);
    applyStatsPrior(battle, 'p1', [{ itemUnknown: false, abilityUnknown: false }], { items: true, abilities: true });
    expect((battle.p2.pokemon[0] as any).item).toBe('');
  });

  test('without hidden marks only the move fill runs', () => {
    const battle = battleWith('Garchomp', ['scaleshot']);
    applyStatsPrior(battle, 'p1', undefined, { items: true, abilities: true });
    expect((battle.p2.pokemon[0] as any).item).toBe('');
  });

  test('placeholders skip revealed species and are deterministic', () => {
    const a = placeholderSets(['Garchomp'], 2);
    const b = placeholderSets(['Garchomp'], 2);
    expect(a).toEqual(b);
    expect(a.map(set => set.species).sort()).toEqual(['Pikachu', 'Snorlax']);
    const lax = a.find(set => set.species === 'Snorlax')!;
    expect(lax.item).toBe('Leftovers');
    expect(lax.moves).toEqual(['bodyslam', 'earthquake']);
  });
});
