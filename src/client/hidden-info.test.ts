import { PRNG } from '@pkmn/sim';
import { EXACT_1PLY, exactSearch } from '../engine/exact/search.js';
import { legalChoices, safeChoose, startRandomBattle, teamsForSeed, type SideId } from '../engine/exact/battle-utils.js';
import { runGame } from '../bench/game.js';
import { ladderDecisionBattle, viewerLines } from './hidden-info.js';

function opened(seed: number) {
  const teams = teamsForSeed(seed);
  return startRandomBattle(teams.p1, teams.p2, seed);
}

function speciesIn(log: readonly string[], side: SideId): Set<string> {
  const seen = new Set<string>();
  for (const line of viewerLines(log, side)) {
    if (!line.startsWith('|switch|') && !line.startsWith('|drag|') && !line.startsWith('|replace|')) continue;
    const parts = line.split('|');
    if (!(parts[2] || '').toLowerCase().startsWith(side)) continue;
    const species = (parts[3] || '').split(',')[0].trim().toLowerCase();
    if (species) seen.add(species);
  }
  return seen;
}

function movesIn(log: readonly string[], side: SideId, species: string): string[] {
  const want = species.toLowerCase();
  const moves: string[] = [];
  for (const line of viewerLines(log, side)) {
    if (!line.startsWith('|move|')) continue;
    const parts = line.split('|');
    const ident = parts[2] || '';
    if (!ident.toLowerCase().startsWith(side)) continue;
    const name = (ident.split(':')[1] || '').trim().toLowerCase();
    if (name !== want) continue;
    const id = (parts[3] || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (id && !moves.includes(id)) moves.push(id);
  }
  return moves;
}

describe('ladder hidden information', () => {
  it('shows a side its own exact HP and the foe as a percent', () => {
    const battle = opened(7);
    const foe = battle.p2.active[0];
    const ours = battle.p1.active[0];
    if (!foe || !ours) throw new Error('no active');
    const lines = viewerLines(battle.log, 'p1');
    const foeLine = lines.find(line => line.startsWith('|switch|') && line.includes(foe.species.name));
    const ourLine = lines.find(line => line.startsWith('|switch|') && line.includes(ours.species.name));
    expect(foeLine).toBeDefined();
    expect(ourLine).toBeDefined();
    expect(foeLine).toContain('100/100');
    expect(ourLine).toContain(`${ours.hp}/${ours.maxhp}`);
    if (foe.maxhp !== 100) expect(foeLine).not.toContain(`${foe.hp}/${foe.maxhp}`);
    expect(lines.some(line => line.startsWith('|split|'))).toBe(false);
  });

  it('hides unrevealed teammates, moves, and items from the decision battle', () => {
    const battle = opened(7);
    const viewed = ladderDecisionBattle(battle, 'p1');
    expect(viewed).not.toBeNull();
    if (!viewed) return;

    const realFoe = battle.p2;
    const seen = speciesIn(battle.log, 'p2');
    expect(seen.size).toBe(1);
    expect(realFoe.pokemon.length).toBe(6);
    expect(viewed.p2.pokemon.map(mon => mon.species.name.toLowerCase())).toEqual([...seen]);
    expect(viewed.p1.pokemon.length).toBe(6);

    const foeActive = viewed.p2.active[0];
    const realActive = realFoe.active[0];
    if (!foeActive || !realActive) throw new Error('no active');
    expect(foeActive.moveSlots.map(slot => slot.id)).toEqual(['tackle']);
    expect(realActive.moveSlots.map(slot => slot.id)).not.toEqual(['tackle']);
    expect(foeActive.item).toBe('');

    expect(viewed.p1.active[0]?.moveSlots.map(slot => slot.id)).toEqual(
      battle.p1.active[0]?.moveSlots.map(slot => slot.id),
    );
    expect(legalChoices(viewed, 'p1', { tera: true })).toEqual(legalChoices(battle, 'p1', { tera: true }));
  });

  it('keeps request indexes legal as reveals arrive', () => {
    const battle = opened(11);
    const rng = new PRNG([11, 3, 5, 7] as any);
    let steps = 0;
    while (!battle.ended && steps < 8) {
      steps++;
      for (const side of ['p1', 'p2'] as const) {
        const legal = legalChoices(battle, side);
        if (legal.length === 0 || legal[0] === 'default') continue;
        const viewed = ladderDecisionBattle(battle, side);
        expect(viewed).not.toBeNull();
        if (!viewed) continue;
        expect(legalChoices(viewed, 'p1', { tera: true })).toEqual(legalChoices(battle, side, { tera: true }));

        const foeId: SideId = side === 'p1' ? 'p2' : 'p1';
        const seen = speciesIn(battle.log, foeId);
        const names = viewed.p2.pokemon.map(mon => mon.species.name.toLowerCase());
        expect(new Set(names)).toEqual(seen);
        for (const mon of viewed.p2.pokemon) {
          const used = movesIn(battle.log, foeId, mon.species.name);
          const ids = mon.moveSlots.map(slot => String(slot.id));
          const real = battle.getSide(foeId).pokemon.find(row => row.species.name === mon.species.name);
          const realIds = new Set((real?.moveSlots || []).map(slot => String(slot.id)));
          for (const id of ids) {
            const filler = id === 'tackle' && ids.length === 1 && used.length === 0;
            expect(filler || realIds.has(id)).toBe(true);
          }
          if (used.length === 0 && realIds.size > 1 && !ids.includes('tackle')) {
            expect(ids.length).toBeLessThan(realIds.size);
          }
          for (const id of used) expect(ids).toContain(id);
        }
      }
      const p1 = legalChoices(battle, 'p1');
      const p2 = legalChoices(battle, 'p2');
      if (p1.length === 0 && p2.length === 0) break;
      if (p1.length) safeChoose(battle, 'p1', p1[rng.random(p1.length)] || p1[0]);
      if (!battle.ended && p2.length) safeChoose(battle, 'p2', p2[rng.random(p2.length)] || p2[0]);
    }
    expect(steps).toBeGreaterThan(1);
  });

  it('answers a knockout with the same switches as the request', () => {
    const battle = opened(4);
    const active = battle.p1.active[0];
    if (!active) throw new Error('no active');
    active.hp = 0;
    active.fainted = true;
    battle.p1.pokemonLeft = battle.p1.pokemon.filter(mon => !mon.fainted).length;
    active.switchFlag = true;
    battle.makeRequest('switch');

    const legal = legalChoices(battle, 'p1');
    expect(legal.every(choice => choice.startsWith('switch'))).toBe(true);
    const viewed = ladderDecisionBattle(battle, 'p1');
    expect(viewed).not.toBeNull();
    if (!viewed) return;
    expect(legalChoices(viewed, 'p1')).toEqual(legal);
  });

  it('stops offering tera once the side has used it', () => {
    let checked = 0;
    for (let seed = 1; seed <= 40 && checked < 3; seed++) {
      const battle = opened(seed);
      let guard = 0;
      while (!battle.ended && guard++ < 30 && checked < 3) {
        let terastallized = false;
        for (const side of ['p1', 'p2'] as const) {
          const legal = legalChoices(battle, side, { tera: true });
          if (legal.length === 0) continue;
          if (legal[0] === 'default') {
            battle.choose(side, 'default');
            continue;
          }
          const tera = legal.find(choice => choice.includes('terastallize'));
          safeChoose(battle, side, tera || legal.find(choice => choice.startsWith('move')) || legal[0]);
          if (tera) terastallized = true;
        }
        if (!terastallized || battle.ended) continue;
        for (const side of ['p1', 'p2'] as const) {
          const legal = legalChoices(battle, side, { tera: true });
          if (!legal.some(choice => choice.startsWith('move'))) continue;
          if (legal.some(choice => choice.includes('terastallize'))) continue;
          const viewed = ladderDecisionBattle(battle, side);
          expect(viewed).not.toBeNull();
          if (!viewed) continue;
          const viewedLegal = legalChoices(viewed, 'p1', { tera: true });
          expect(viewedLegal.some(choice => choice.includes('terastallize'))).toBe(false);
          expect(viewedLegal).toEqual(legal);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('plays a hidden-info game without an illegal choice', async () => {
    const fast = { ...EXACT_1PLY, samples: 1 };
    const teams = teamsForSeed(3);
    const hidden = await runGame({
      index: 0,
      seed: 3,
      p1Team: teams.p1,
      p2Team: teams.p2,
      p1: { kind: 'exact', config: fast },
      p2: { kind: 'maxdamage' },
      information: 'hidden',
    });
    expect(hidden.crashed).toBe(false);
    expect(hidden.p1Invalid).toBe(0);
    expect(hidden.p2Invalid).toBe(0);
    expect(hidden.p1ViewMiss).toBe(0);
    expect(hidden.p2ViewMiss).toBe(0);
    expect(hidden.information).toBe('hidden');
    expect(['p1', 'p2', 'tie']).toContain(hidden.winner);

    const traceBattle = opened(9);
    const viewed = ladderDecisionBattle(traceBattle, 'p1');
    expect(viewed).not.toBeNull();
    if (!viewed) return;
    const picked = exactSearch(viewed, 'p1', fast).choice;
    expect(legalChoices(traceBattle, 'p1')).toContain(picked);
  }, 60000);
});
