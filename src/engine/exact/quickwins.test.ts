import { Battle, PRNG } from '@pkmn/sim';
import * as fs from 'fs';
import {
  hpEval,
  legalChoices,
  playChoices,
  snapshot,
  startRandomBattle,
  teamsForSeed,
} from './battle-utils.js';
import { maxDamageChoice } from './max-damage.js';
import { damagingImmune, randbatsSpeciesCount, revealOnly } from './public.js';
import { EXACT_1PLY, EXACT_1PLY_PREVIOUS, exactSearch } from './search.js';

/**
 * Positions are taken from seeded gen9randombattle games. The label is a
 * structural check (tera swing, immunity, setup into a hidden KO), not a
 * hand-picked species. These tests do not read or write data/gen9-stats.json.
 */

const STATS_PATH = 'data/gen9-stats.json';

function open(seed: number): Battle {
  const teams = teamsForSeed(seed);
  const battle = startRandomBattle(teams.p1, teams.p2, seed);
  if (battle.requestState === 'teampreview') {
    battle.choose('p1', 'default');
    battle.choose('p2', 'default');
  }
  return battle;
}

function moveId(battle: Battle, choice: string): string {
  const index = Number(choice.split(' ')[1]) - 1;
  return battle.p1.active[0]?.moveSlots[index]?.id || '';
}

function foeChoice(battle: Battle): string {
  return maxDamageChoice(battle, 'p2', legalChoices(battle, 'p2'));
}

function after(battle: Battle, choice: string): number {
  const next = Battle.fromJSON(JSON.parse(snapshot(battle)));
  playChoices(next, 'p1', choice, foeChoice(next));
  return hpEval(next, 'p1');
}

describe('ladder quick wins on generated positions', () => {
  const statsBefore = fs.existsSync(STATS_PATH) ? fs.statSync(STATS_PATH).mtimeMs : null;

  afterAll(() => {
    const statsAfter = fs.existsSync(STATS_PATH) ? fs.statSync(STATS_PATH).mtimeMs : null;
    expect(statsAfter).toBe(statsBefore);
  });

  it('uses a randbats pool of at least 500 species', () => {
    expect(randbatsSpeciesCount()).toBeGreaterThanOrEqual(500);
  });

  it('terastallizes when that line is a strict one-turn improvement', () => {
    let found = 0;
    for (let seed = 1; seed <= 80 && found < 2; seed++) {
      const battle = open(seed);
      const active = battle.p1.activeRequest as { active?: Array<{ canTerastallize?: string }> };
      if (!active.active?.[0]?.canTerastallize) continue;
      const plain = legalChoices(battle, 'p1').filter(choice => choice.startsWith('move '));
      if (plain.length === 0) continue;
      let bestPlain = -Infinity;
      for (const choice of [...plain, ...legalChoices(battle, 'p1', { tera: false }).filter(c => c.startsWith('switch'))]) {
        bestPlain = Math.max(bestPlain, after(battle, choice));
      }
      let bestTera = -Infinity;
      let teraChoice = '';
      for (const choice of plain) {
        const tera = `${choice} terastallize`;
        const score = after(battle, tera);
        if (score > bestTera) {
          bestTera = score;
          teraChoice = tera;
        }
      }
      if (!teraChoice || bestTera < bestPlain + 1.5) continue;
      found++;
      const previous = exactSearch(battle, 'p1', EXACT_1PLY_PREVIOUS);
      const next = exactSearch(battle, 'p1', EXACT_1PLY);
      expect(previous.choice.includes('terastallize')).toBe(false);
      expect(next.choice.includes('terastallize')).toBe(true);
      expect(legalChoices(battle, 'p1', { tera: true })).toContain(next.choice);
    }
    expect(found).toBeGreaterThan(0);
  });

  it('does not click an immune move when a later move still hits', () => {
    let found = 0;
    for (let seed = 1; seed <= 120 && found < 2; seed++) {
      const battle = open(seed);
      const foe = battle.p2.active[0];
      const mon = battle.p1.active[0];
      if (!foe || !mon) continue;
      const moves = legalChoices(battle, 'p1').filter(choice => choice.startsWith('move '));
      const immune = moves.find(choice => damagingImmune(moveId(battle, choice), foe));
      const hits = moves.find(choice => {
        const id = moveId(battle, choice);
        return id && !damagingImmune(id, foe) && battle.dex.moves.get(id).basePower > 0;
      });
      if (!immune || !hits || moves[0] !== immune) continue;
      mon.trapped = true;
      battle.makeRequest('move');
      const foeMon = battle.p2.active[0];
      if (foeMon) foeMon.boosts.spe = 6;
      mon.hp = 1;
      battle.makeRequest('move');
      const refreshed = legalChoices(battle, 'p1').filter(choice => choice.startsWith('move '));
      if (!refreshed.includes(immune) || !refreshed.includes(hits)) continue;
      const previous = exactSearch(battle, 'p1', EXACT_1PLY_PREVIOUS);
      const next = exactSearch(battle, 'p1', EXACT_1PLY);
      if (damagingImmune(moveId(battle, previous.choice), foe)) {
        found++;
        expect(damagingImmune(moveId(battle, next.choice), foe)).toBe(false);
        expect(next.choice.startsWith('move ')).toBe(true);
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  it('does not set up into a KO the revealed board is hiding', () => {
    let found = 0;
    for (let seed = 1; seed <= 400 && found < 2; seed++) {
      const battle = open(seed);
      const mon = battle.p1.active[0];
      const foe = battle.p2.active[0];
      if (!mon || !foe) continue;
      const moves = legalChoices(battle, 'p1').filter(choice => choice.startsWith('move '));
      const setup = moves.find(choice => {
        const move = battle.dex.moves.get(moveId(battle, choice));
        return move.category === 'Status' && Boolean(move.boosts) && (move.target === 'self' || move.target === 'allySide');
      });
      const attack = moves.find(choice => {
        const id = moveId(battle, choice);
        const move = battle.dex.moves.get(id);
        return move.basePower > 0 && !damagingImmune(id, foe);
      });
      // Slot order is the tie break. The old search keeps the first move
      // when every line faints before we act.
      if (!setup || !attack || moves[0] !== setup) continue;
      const foeHits = foe.moveSlots.some(slot => battle.dex.moves.get(slot.id).basePower > 0);
      if (!foeHits) continue;
      mon.trapped = true;
      mon.hp = 1;
      foe.boosts.spe = 6;
      battle.makeRequest('move');
      const hidden = revealOnly(battle, 'p1');
      const previous = exactSearch(hidden, 'p1', { ...EXACT_1PLY_PREVIOUS, samples: 1 });
      const next = exactSearch(hidden, 'p1', { ...EXACT_1PLY, samples: 1 });
      if (previous.choice !== setup) continue;
      found++;
      expect(next.choice).not.toBe(setup);
      expect(next.choice.startsWith('move ') || next.choice.startsWith('switch ')).toBe(true);
    }
    expect(found).toBeGreaterThan(0);
  });
});
