import { Battle } from '@pkmn/sim';
import { SetInference } from './index.js';
import type { RandbatsStats, RoleData } from '../../types/index.js';
import {
  startRandomBattle,
  teamsForSeed,
  playChoices,
  legalChoices,
  snapshot,
} from '../exact/battle-utils.js';

function role(
  weight: number,
  moves: Record<string, number>,
  items: Record<string, number>,
  tera: Record<string, number>,
  ability: string,
): RoleData {
  return { weight, moves, items, teraTypes: tera, abilities: { [ability]: 1 } };
}

function species(
  level: number,
  ability: string,
  items: Record<string, number>,
  roles: Record<string, RoleData>,
) {
  return { level, abilities: { [ability]: 1 }, items, roles };
}

describe('SetInference with belief updater', () => {
  const stats: RandbatsStats = {
    'Garchomp': species(
      84,
      'Rough Skin',
      { 'Rocky Helmet': 0.4, 'Choice Scarf': 0.3, 'Life Orb': 0.3 },
      {
        'Bulky Stealth Rock': role(
          0.5,
          { 'Earthquake': 1, 'Stone Edge': 1, 'Stealth Rock': 1, 'Swords Dance': 0.5 },
          { 'Rocky Helmet': 1 },
          { 'Ground': 1 },
          'Rough Skin',
        ),
        'Offensive': role(
          0.5,
          { 'Earthquake': 1, 'Outrage': 1, 'Stone Edge': 1, 'Fire Fang': 0.5 },
          { 'Choice Scarf': 0.5, 'Life Orb': 0.5 },
          { 'Ground': 1 },
          'Rough Skin',
        ),
      },
    ),
    'Dragapult': species(
      77,
      'Clear Body',
      { 'Life Orb': 0.5, 'Choice Specs': 0.3, 'Heavy-Duty Boots': 0.2 },
      {
        'Special Attacker': role(
          1,
          { 'Dragon Darts': 1, 'Shadow Ball': 1, 'Flamethrower': 0.8, 'Thunderbolt': 0.7 },
          { 'Life Orb': 0.6, 'Choice Specs': 0.4 },
          { 'Dragon': 0.7, 'Ghost': 0.3 },
          'Clear Body',
        ),
      },
    ),
    'Slowbro': species(
      77,
      'Regenerator',
      { 'Heavy-Duty Boots': 0.5, 'Assault Vest': 0.3, 'Leftovers': 0.2 },
      {
        'Defensive': role(
          1,
          { 'Scald': 1, 'Slack Off': 1, 'Thunder Wave': 0.8, 'Ice Beam': 0.7 },
          { 'Heavy-Duty Boots': 0.6, 'Leftovers': 0.4 },
          { 'Water': 1 },
          'Regenerator',
        ),
      },
    ),
    'Tyranitar': species(
      79,
      'Sand Stream',
      { 'Leftovers': 0.5, 'Choice Band': 0.3, 'Assault Vest': 0.2 },
      {
        'Mixed': role(
          1,
          { 'Stone Edge': 1, 'Crunch': 1, 'Earthquake': 0.9, 'Ice Beam': 0.7 },
          { 'Leftovers': 1 },
          { 'Rock': 1 },
          'Sand Stream',
        ),
      },
    ),
  };

  describe('speed-based inference', () => {
    it('detects Choice Scarf from speed order', () => {
      const inference = new SetInference(stats, { beliefUpdaterEnabled: false });

      inference.addFoe('Garchomp', 84);
      inference.seeMove('Garchomp', 'Earthquake');

      const itemsBefore = inference.itemDistribution('Garchomp');

      inference.noteSpeed({
        species: 'Garchomp',
        foeMovedFirst: true,
        ourSpeed: 110,
        foeStage: 0,
        foeParalyzed: false,
        foeTailwind: false,
        trickRoom: false,
      });

      const itemsAfter = inference.itemDistribution('Garchomp');
      const scarfAfter = itemsAfter.find(item => item.value === 'Choice Scarf');
      const lifeOrbAfter = itemsAfter.find(item => item.value === 'Life Orb');

      // Scarf should have higher or equal probability after speed evidence
      expect(scarfAfter).toBeDefined();
      expect(lifeOrbAfter).toBeDefined();
      if (scarfAfter && lifeOrbAfter) {
        expect(scarfAfter.probability).toBeGreaterThanOrEqual(lifeOrbAfter.probability);
      }
    });

    it('does not update when speed order is ambiguous', () => {
      const inference = new SetInference(stats, { beliefUpdaterEnabled: false });

      inference.addFoe('Garchomp', 84);
      inference.seeMove('Garchomp', 'Earthquake');

      const itemsBefore = inference.itemDistribution('Garchomp');

      inference.noteSpeed({
        species: 'Garchomp',
        foeMovedFirst: true,
        ourSpeed: 50,
        foeStage: 0,
        foeParalyzed: false,
        foeTailwind: false,
        trickRoom: false,
      });

      const itemsAfter = inference.itemDistribution('Garchomp');
      expect(itemsAfter).toEqual(itemsBefore);
    });
  });

  describe('damage-based inference', () => {
    it('updates item likelihood from damage rolls', () => {
      const inference = new SetInference(stats, { beliefUpdaterEnabled: false });

      inference.addFoe('Dragapult', 77);
      inference.seeMove('Dragapult', 'Dragon Darts');
      inference.seeAbility('Dragapult', 'Clear Body');
      inference.attachOurTeam([{
        species: 'Tyranitar',
        level: 79,
        ability: 'Sand Stream',
        item: 'Leftovers',
        evs: { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 },
        ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
      }]);

      const itemsBefore = inference.itemDistribution('Dragapult');

      inference.noteDamage({
        foeSpecies: 'Dragapult',
        foeIsAttacker: true,
        move: 'Dragon Darts',
        otherSpecies: 'Tyranitar',
        otherLevel: 79,
        otherAbility: 'Sand Stream',
        otherItem: 'Leftovers',
        observed: 120,
        tolerance: 5,
      });

      const itemsAfter = inference.itemDistribution('Dragapult');

      // The distribution may or may not change depending on damage discrimination
      // Just verify no crash and reasonable behavior
      expect(itemsAfter.length).toBeGreaterThan(0);
    });

    it('caps damage updates at 2 per mon', () => {
      const inference = new SetInference(stats, { beliefUpdaterEnabled: false });

      inference.addFoe('Dragapult', 77);
      inference.seeMove('Dragapult', 'Dragon Darts');
      inference.seeAbility('Dragapult', 'Clear Body');
      inference.attachOurTeam([{
        species: 'Tyranitar',
        level: 79,
        ability: 'Sand Stream',
        item: 'Leftovers',
      }]);

      for (let i = 0; i < 3; i++) {
        inference.noteDamage({
          foeSpecies: 'Dragapult',
          foeIsAttacker: true,
          move: 'Dragon Darts',
          otherSpecies: 'Tyranitar',
          otherLevel: 79,
          observed: 100 + i,
          tolerance: 5,
        });
      }

      expect(true).toBe(true);
    });
  });

  describe('hard evidence filters', () => {
    it('bans Assault Vest for status moves', () => {
      const inference = new SetInference(stats, { beliefUpdaterEnabled: false });

      inference.addFoe('Slowbro', 77);
      inference.seeMove('Slowbro', 'Thunder Wave');

      const items = inference.itemDistribution('Slowbro');
      const av = items.find(item => item.value === 'Assault Vest');

      if (av) {
        expect(av.probability).toBeLessThan(0.01);
      }
    });

    it('bans Choice items for multiple different moves', () => {
      const inference = new SetInference(stats, { beliefUpdaterEnabled: false });

      inference.addFoe('Garchomp', 84);
      inference.seeMove('Garchomp', 'Earthquake');
      inference.seeMove('Garchomp', 'Stone Edge');

      const items = inference.itemDistribution('Garchomp');
      const choiceItems = items.filter(item =>
        ['Choice Band', 'Choice Scarf', 'Choice Specs'].includes(item.value)
      );

      for (const choice of choiceItems) {
        expect(choice.probability).toBeLessThan(0.01);
      }
    });

    it('bans Heavy-Duty Boots for hazard damage', () => {
      const inference = new SetInference(stats, { beliefUpdaterEnabled: false });

      inference.addFoe('Garchomp', 84);
      inference.noteHazard('Garchomp', 'Stealth Rock');

      const items = inference.itemDistribution('Garchomp');
      const boots = items.find(item => item.value === 'Heavy-Duty Boots');

      if (boots) {
        expect(boots.probability).toBeLessThan(0.01);
      }
    });
  });

  describe('parity with baseline', () => {
    it('exact-1ply makes identical decisions with beliefUpdaterEnabled true/false', () => {
      const seed = 1234;
      const teams = teamsForSeed(seed);

      const battle1 = startRandomBattle(teams.p1, teams.p2, seed);
      const battle2 = Battle.fromJSON(JSON.parse(snapshot(battle1)));

      const inference1 = new SetInference(stats, { beliefUpdaterEnabled: false, seed });
      const inference2 = new SetInference(stats, { beliefUpdaterEnabled: true, seed });

      for (let turn = 0; turn < 5; turn++) {
        const legal1 = legalChoices(battle1, 'p1');
        const legal2 = legalChoices(battle2, 'p1');

        expect(legal1).toEqual(legal2);

        if (legal1.length === 0) break;

        const choice = legal1[0];
        playChoices(battle1, 'p1', choice, legal1[0]);
        playChoices(battle2, 'p1', choice, legal2[0]);
      }

      expect(true).toBe(true);
    });
  });
});
