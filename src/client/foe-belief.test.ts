import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from '@jest/globals';
import { PRNG } from '@pkmn/sim';
import { legalChoices, safeChoose, snapshot, startRandomBattle, teamsForSeed } from '../engine/exact/battle-utils.js';
import { randbatsStat } from '../engine/set-inference/catalog.js';
import { setUsageStatsForTests } from '../engine/exact/stats-prior.js';
import { loadConfig } from '../config/load.js';
import type { RandbatsStats, RoleData } from '../types/index.js';
import type { LivePosition } from './decision-battle.js';
import { applyFoeBelief, beliefStats, FoeBeliefSession, ourTeamFromRequest } from './foe-belief.js';
import { ladderDecisionBattle } from './hidden-info.js';

function role(weight: number, moves: Record<string, number>, items: Record<string, number>, ability: string): RoleData {
  return { weight, moves, items, teraTypes: { Normal: 1 }, abilities: { [ability]: 1 } };
}

const fixture: RandbatsStats = {
  Garchomp: {
    level: 84,
    abilities: { 'Rough Skin': 1 },
    items: { 'Choice Scarf': 0.5, 'Life Orb': 0.5 },
    roles: {
      Scarf: role(0.5, { Earthquake: 1, Outrage: 1, 'Stone Edge': 1, 'Fire Fang': 1 }, { 'Choice Scarf': 1 }, 'Rough Skin'),
      Setup: role(0.5, { Earthquake: 1, 'Swords Dance': 1, 'Scale Shot': 1, 'Stone Edge': 1 }, { 'Life Orb': 1 }, 'Rough Skin'),
    },
  },
  Snorlax: {
    level: 84,
    abilities: { 'Thick Fat': 1 },
    items: { Leftovers: 1 },
    roles: { Bulky: role(1, { 'Body Slam': 1, Earthquake: 1, Rest: 1, Curse: 1 }, { Leftovers: 1 }, 'Thick Fat') },
  },
} as unknown as RandbatsStats;

describe('foe belief fill (unit fixture)', () => {
  const request = {
    side: {
      pokemon: [{
        ident: 'p1: Snorlax',
        details: 'Snorlax, L84',
        condition: '400/400',
        ability: 'thickfat',
        item: 'leftovers',
        stats: { atk: randbatsStat(110, 84), def: randbatsStat(65, 84), spa: randbatsStat(65, 84), spd: randbatsStat(110, 84), spe: randbatsStat(30, 84) },
      }],
    },
  };

  it('fills Choice Scarf after the foe outspeeds what its plain speed allows', () => {
    const session = new FoeBeliefSession('p1', { stats: fixture });
    const lines = [
      '|switch|p1a: Snorlax|Snorlax, L84|400/400',
      '|switch|p2a: Garchomp|Garchomp, L84|100/100',
      '|turn|1',
    ];
    session.update(lines, request);
    const before = session.fills().find(fill => fill.species === 'Garchomp');
    expect(before?.item).toBeUndefined();
    // A +4 Snorlax (3x) outspeeds a plain Garchomp but not a Scarf one, so
    // Garchomp moving first at equal priority only fits Choice Scarf.
    lines.push(
      '|-boost|p1a: Snorlax|spe|4',
      '|move|p2a: Garchomp|Earthquake|p1a: Snorlax',
      '|move|p1a: Snorlax|Body Slam|p2a: Garchomp',
      '|turn|2',
    );
    session.update(lines, request);
    const plain = randbatsStat(102, 84);
    const ours = Math.floor(randbatsStat(30, 84) * 3);
    expect(ours).toBeGreaterThan(plain);
    expect(ours).toBeLessThan(Math.floor(plain * 1.5));
    const after = session.fills().find(fill => fill.species === 'Garchomp');
    expect(after?.item).toBe('Choice Scarf');
    expect(after?.moves).toContain('earthquake');
    expect(after?.moves.length).toBe(4);
  });

  it('never overwrites revealed facts and fills only hidden ones', () => {
    const position: LivePosition = {
      request: {},
      foeActive: { species: 'Garchomp', level: 84, hp: 100, maxhp: 100, moves: ['earthquake'], item: 'Life Orb', ability: undefined, itemUnknown: false, abilityUnknown: true },
      foeBench: [{ species: 'Snorlax', level: 84, hp: 100, maxhp: 100, moves: ['bodyslam', 'earthquake', 'rest', 'curse'], itemUnknown: true, abilityUnknown: true }],
    };
    const filled = applyFoeBelief(position, [
      { species: 'Garchomp', moves: ['earthquake', 'outrage', 'stoneedge', 'firefang'], item: 'Choice Scarf', ability: 'Rough Skin' },
      { species: 'Snorlax', moves: ['bodyslam', 'earthquake'], item: 'Leftovers', ability: 'Thick Fat' },
    ], fixture);
    expect(filled.foeActive?.item).toBe('Life Orb');
    expect(filled.foeActive?.ability).toBe('Rough Skin');
    expect(filled.foeActive?.moves).toEqual(['earthquake', 'outrage', 'stoneedge', 'firefang']);
    expect(filled.foeBench[0].moves).toEqual(['bodyslam', 'earthquake', 'rest', 'curse']);
    expect(filled.foeBench[0].item).toBe('Leftovers');
    expect(position.foeActive?.moves).toEqual(['earthquake']);
  });

  it('reads our spreads from the request (Trick Room 0 Speed IV)', () => {
    const team = ourTeamFromRequest({
      side: { pokemon: [{ details: 'Snorlax, L84', stats: { atk: randbatsStat(110, 84), def: 1, spa: 1, spd: 1, spe: randbatsStat(30, 84, 0, 0) } }] },
    });
    expect(team[0].ivs?.spe).toBe(0);
    expect(team[0].evs?.spe).toBe(0);
    expect(team[0].ivs?.atk).toBe(31);
  });

  it('refuses a fixture-sized production table', () => {
    setUsageStatsForTests(fixture as any);
    try {
      expect(() => beliefStats()).toThrow(/randbats species/);
    } finally {
      setUsageStatsForTests(null);
    }
  });
});

/** Snapshot without the wall-clock `|t:|` lines the sim writes into its log. */
function stable(battle: Parameters<typeof snapshot>[0]): string {
  return snapshot(battle).replace(/\|t:\|\d+/g, '|t:|');
}

const hasData = fs.existsSync(path.join(process.cwd(), 'data', 'gen9-stats.json'));
const describeData = hasData ? describe : describe.skip;

describeData('foe belief on the real randbats table', () => {
  it('loads the full table', () => {
    expect(Object.keys(beliefStats()).length).toBeGreaterThanOrEqual(500);
  });

  it('changes only the foe: our legal choices and revealed foe facts are identical at every decision', () => {
    let decisions = 0;
    let filledItems = 0;
    for (const seed of [3, 17]) {
      const teams = teamsForSeed(seed);
      const battle = startRandomBattle(teams.p1, teams.p2, seed);
      const rng = new PRNG([seed, 1, 2, 3] as any);
      for (let loop = 0; loop < 60 && !battle.ended; loop++) {
        for (const side of ['p1', 'p2'] as const) {
          const legal = legalChoices(battle, side);
          if (legal.length === 0) continue;
          const base = ladderDecisionBattle(battle, side, {});
          const belief = ladderDecisionBattle(battle, side, { foeBelief: true });
          expect(!!belief).toBe(!!base);
          if (base && belief) {
            decisions++;
            expect(legalChoices(belief, 'p1')).toEqual(legalChoices(base, 'p1'));
            expect(stable(ladderDecisionBattle(battle, side, { foeBelief: false })!)).toBe(stable(base));
            base.p2.pokemon.forEach((mon, i) => {
              const other = belief.p2.pokemon[i];
              expect(other.species.name).toBe(mon.species.name);
              expect(other.hp).toBe(mon.hp);
              if (mon.item) expect(other.item).toBe(mon.item);
              if (!mon.item && other.item) filledItems++;
              const known = mon.moveSlots.map(slot => slot.id).filter(id => id !== 'tackle');
              for (const id of known) expect(other.moveSlots.map(slot => slot.id)).toContain(id);
            });
          }
        }
        for (const side of ['p1', 'p2'] as const) {
          const legal = legalChoices(battle, side);
          if (legal.length) safeChoose(battle, side, legal[Math.floor(rng.random() * legal.length)]);
        }
      }
    }
    expect(decisions).toBeGreaterThan(20);
    expect(filledItems).toBeGreaterThan(0);
  }, 120000);
});

describe('config parity', () => {
  const cfg = (name: string) => loadConfig(path.join(process.cwd(), 'configs', `${name}.yaml`));

  it('leaves champion and stacked-qw-fitted config ids unchanged', () => {
    expect(cfg('champion').configId).toBe('064cad7ec4ed0241');
    expect(cfg('stacked-qw-fitted').configId).toBe('a582e1386f6392ce');
    expect(cfg('stacked-qw-fitted').config.search.params.foeBelief).toBeUndefined();
  });
});
