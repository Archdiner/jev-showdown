import { Dex, Teams } from '@pkmn/sim';
import { ensureGenerators, startRandomBattle, teamsForSeed } from './battle-utils.js';
import { estimatedMaxHp, marginAgainst, rankedSwitches, switchFeatureInput } from './matchup.js';

/**
 * Regression: randbats picks cosmetic formes (Alcremie-Matcha-Cream,
 * Sawsbuck-Winter) that @smogon/calc does not know. estimatedMaxHp built a
 * calc Pokemon from the raw name and threw "Cannot read properties of
 * undefined (reading 'hp')", which crashed 10-16% of bench games for every
 * config that ranks foe switches (replySolve*, replyModel: switch, endgame).
 */
describe('matchup on cosmetic formes', () => {
  test('every randbats species and cosmetic forme has a neutral max HP equal to its base forme', () => {
    ensureGenerators();
    const sets = (Teams.getGenerator('gen9randombattle') as any).randomSets || {};
    const names = new Set<string>();
    for (const id of Object.keys(sets)) {
      const species = Dex.species.get(id);
      if (!species.exists) continue;
      names.add(species.name);
      for (const forme of species.cosmeticFormes || []) names.add(forme);
      const base = Dex.species.get(species.baseSpecies);
      for (const forme of base.cosmeticFormes || []) names.add(forme);
    }
    expect(names.has('Alcremie-Matcha-Cream')).toBe(true);
    expect(names.has('Sawsbuck-Winter')).toBe(true);
    for (const name of names) {
      const hp = estimatedMaxHp(name, 85);
      expect(Number.isFinite(hp)).toBe(true);
      const species = Dex.species.get(name);
      if (species.cosmeticFormes === undefined && species.baseSpecies !== species.name && species.forme
        && (Dex.species.get(species.baseSpecies).cosmeticFormes || []).includes(name)) {
        expect(hp).toBe(estimatedMaxHp(species.baseSpecies, 85));
      }
    }
    expect(estimatedMaxHp('Alcremie-Matcha-Cream', 88)).toBe(estimatedMaxHp('Alcremie', 88));
    expect(estimatedMaxHp('Sawsbuck-Winter', 88)).toBe(estimatedMaxHp('Sawsbuck', 88));
  });

  test('foe switch ranking and switch features run on a bench with cosmetic formes', () => {
    const teams = teamsForSeed(12201);
    teams.p2[1] = { ...teams.p2[1], species: 'Alcremie-Matcha-Cream', name: 'Alcremie-Matcha-Cream' };
    teams.p2[2] = { ...teams.p2[2], species: 'Sawsbuck-Winter', name: 'Sawsbuck-Winter' };
    const battle = startRandomBattle(teams.p1, teams.p2, 12201);
    battle.makeChoices('default', 'default');
    const p2 = battle.getSide('p2');
    expect(p2.pokemon.map(mon => mon.species.name)).toEqual(
      expect.arrayContaining(['Alcremie-Matcha-Cream', 'Sawsbuck-Winter']),
    );
    // The path that crashed: matrixReplies -> rankedSwitches(battle, opp, false).
    const ranked = rankedSwitches(battle, 'p2', false);
    const species = ranked.map(row => row.species);
    expect(species).toEqual(expect.arrayContaining(['Alcremie-Matcha-Cream', 'Sawsbuck-Winter']));
    for (const row of ranked) expect(Number.isFinite(row.margin)).toBe(true);
    expect(() => rankedSwitches(battle, 'p1', true)).not.toThrow();
    expect(() => switchFeatureInput(battle, 'p2')).not.toThrow();
    const foe = battle.getSide('p1').active[0];
    const alcremie = p2.pokemon.find(mon => mon.species.name === 'Alcremie-Matcha-Cream');
    expect(Number.isFinite(marginAgainst(alcremie, foe, false))).toBe(true);
  });
});
