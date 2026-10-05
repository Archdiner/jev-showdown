import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from '@jest/globals';
import { BeliefTracker } from '../belief-tracker.js';
import { WorldBuilder } from '../world-builder.js';
import { gen9RandomBattle } from '../../formats/gen9-randombattle.js';
import type { GameState, RandbatsStats, RoleData } from '../../types/index.js';
import { randbatsStat } from './catalog.js';
import { rollsFor } from './damage.js';
import { SetInference, probabilityOf, sampleWorlds, toPokemonSet } from './index.js';

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

const fixture: RandbatsStats = {
  Ampharos: species(88, 'Static', { 'Assault Vest': 0.5, 'Life Orb': 0.25, 'Choice Specs': 0.25 }, {
    'AV Pivot': role(0.5, {
      'Volt Switch': 1, 'Dragon Pulse': 1, Thunderbolt: 0.5, 'Focus Blast': 0.5,
    }, { 'Assault Vest': 1 }, { Fairy: 1 }, 'Static'),
    Wallbreaker: role(0.5, {
      Thunderbolt: 1, 'Dragon Pulse': 1, 'Focus Blast': 1, Agility: 0.5, 'Volt Switch': 0.5,
    }, { 'Life Orb': 0.5, 'Choice Specs': 0.5 }, { Electric: 1 }, 'Static'),
  }),
  Pikachu: species(88, 'Static', { 'Choice Scarf': 0.5, 'Light Ball': 0.5 }, {
    'Fast Attacker': role(1, {
      Thunderbolt: 1, 'Volt Switch': 1, 'Quick Attack': 0.5, 'Thunder Wave': 0.5,
    }, { 'Choice Scarf': 0.5, 'Light Ball': 0.5 }, { Electric: 1 }, 'Static'),
  }),
  Pelipper: species(83, 'Drizzle', { 'Heavy-Duty Boots': 0.5, Leftovers: 0.5 }, {
    'Bulky Support': role(1, { Hurricane: 1, 'U-turn': 1, Roost: 1, Defog: 1 }, {
      'Heavy-Duty Boots': 0.5, Leftovers: 0.5,
    }, { Water: 1 }, 'Drizzle'),
  }),
  Wingull: species(90, 'Drizzle', { 'Heavy-Duty Boots': 1 }, {
    Support: role(1, { Hurricane: 1 }, { 'Heavy-Duty Boots': 1 }, { Water: 1 }, 'Drizzle'),
  }),
  Tentacruel: species(84, 'Clear Body', { Leftovers: 1 }, {
    Support: role(1, { Scald: 1 }, { Leftovers: 1 }, { Poison: 1 }, 'Clear Body'),
  }),
  Gengar: species(78, 'Cursed Body', { 'Life Orb': 0.5, 'Choice Specs': 0.5 }, {
    Attacker: role(1, { 'Shadow Ball': 1, 'Sludge Wave': 1, 'Focus Blast': 1, Thunderbolt: 1 }, {
      'Life Orb': 0.5, 'Choice Specs': 0.5,
    }, { Ghost: 1 }, 'Cursed Body'),
  }),
  Abra: species(92, 'Magic Guard', { 'Focus Sash': 1 }, {
    Lead: role(1, { Psychic: 1 }, { 'Focus Sash': 1 }, { Psychic: 1 }, 'Magic Guard'),
  }),
  Geodude: species(88, 'Sturdy', { Leftovers: 1 }, {
    Support: role(1, { Earthquake: 1 }, { Leftovers: 1 }, { Rock: 1 }, 'Sturdy'),
  }),
  Onix: species(86, 'Sturdy', { Leftovers: 1 }, {
    Support: role(1, { Earthquake: 1 }, { Leftovers: 1 }, { Rock: 1 }, 'Sturdy'),
  }),
  Magnemite: species(90, 'Sturdy', { Eviolite: 1 }, {
    Support: role(1, { 'Volt Switch': 1 }, { Eviolite: 1 }, { Steel: 1 }, 'Sturdy'),
  }),
};

function foe(stats: RandbatsStats = fixture): SetInference {
  return new SetInference(stats, { ourSide: () => 'p1', seed: 2 });
}

describe('set inference', () => {
  it('matches the raw prior before any evidence', () => {
    const model = foe();
    const prior = new SetInference(fixture, { ourSide: () => 'p1', priorOnly: true });
    model.addFoe('Ampharos', 88);
    prior.addFoe('Ampharos', 88);
    expect(probabilityOf(model.itemDistribution('Ampharos'), 'Assault Vest'))
      .toBeCloseTo(probabilityOf(prior.itemDistribution('Ampharos'), 'Assault Vest'), 6);
    expect(probabilityOf(model.moveDistribution('Ampharos'), 'Agility'))
      .toBeCloseTo(probabilityOf(prior.moveDistribution('Ampharos'), 'Agility'), 6);
  });

  it('drops Assault Vest and Choice items after a status move', () => {
    const model = foe();
    const prior = new SetInference(fixture, { ourSide: () => 'p1', priorOnly: true });
    model.addFoe('Ampharos', 88);
    prior.addFoe('Ampharos', 88);
    model.seeMove('Ampharos', 'Agility');
    prior.seeMove('Ampharos', 'Agility');
    expect(probabilityOf(model.itemDistribution('Ampharos'), 'Assault Vest')).toBe(0);
    expect(probabilityOf(model.itemDistribution('Ampharos'), 'Choice Specs')).toBe(0);
    expect(probabilityOf(model.itemDistribution('Ampharos'), 'Life Orb')).toBeGreaterThan(0.9);
    expect(probabilityOf(prior.itemDistribution('Ampharos'), 'Assault Vest')).toBeGreaterThan(0.2);
    expect(model.roleDistribution('Ampharos').map(row => row.value)).toEqual(['Wallbreaker']);
  });

  it('treats two different moves as not Choice-locked', () => {
    const model = foe();
    model.addFoe('Ampharos', 88);
    model.seeMove('Ampharos', 'Thunderbolt');
    model.seeMove('Ampharos', 'Dragon Pulse');
    expect(probabilityOf(model.itemDistribution('Ampharos'), 'Choice Specs')).toBe(0);
  });

  it('rules out Heavy-Duty Boots after hazard chip', () => {
    const model = foe();
    model.addFoe('Pelipper', 83);
    model.noteHazard('Pelipper', 'Stealth Rock');
    expect(probabilityOf(model.itemDistribution('Pelipper'), 'Heavy-Duty Boots')).toBe(0);
    expect(probabilityOf(model.itemDistribution('Pelipper'), 'Leftovers')).toBeCloseTo(1, 5);
  });

  it('raises Choice Scarf when the foe moved first and only Scarf is fast enough', () => {
    const model = foe();
    const prior = new SetInference(fixture, { ourSide: () => 'p1', priorOnly: true });
    model.addFoe('Pikachu', 88);
    prior.addFoe('Pikachu', 88);
    const plain = randbatsStat(90, 88);
    const scarf = Math.floor(plain * 1.5);
    expect(scarf).toBeGreaterThan(plain + 1);
    model.noteSpeed({ species: 'Pikachu', foeMovedFirst: true, ourSpeed: plain + 1 });
    expect(probabilityOf(model.itemDistribution('Pikachu'), 'Choice Scarf'))
      .toBeGreaterThan(probabilityOf(prior.itemDistribution('Pikachu'), 'Choice Scarf'));
    expect(probabilityOf(model.itemDistribution('Pikachu'), 'Choice Scarf')).toBeGreaterThan(0.8);
  });

  it('reads a public log without giving the prior the same item update', () => {
    const model = foe();
    const prior = new SetInference(fixture, { ourSide: () => 'p1', priorOnly: true });
    const reveal = '|move|p2a: Ampharos|Agility|p1a: Pikachu';
    for (const line of ['|switch|p2a: Ampharos|Ampharos, L88|100/100', reveal]) {
      expect(model.upcoming(reveal)?.truth).toBe(line === reveal ? 'Agility' : model.upcoming(reveal)?.truth);
      model.observe(line);
      prior.observe(line);
    }
    expect(probabilityOf(model.itemDistribution('Ampharos'), 'Life Orb'))
      .toBeGreaterThan(probabilityOf(prior.itemDistribution('Ampharos'), 'Life Orb'));
  });

  it('moves Life Orb up when the damage roll misses the unboosted range', () => {
    const model = foe();
    model.addFoe('Gengar', 78);
    const shared = {
      attackerSpecies: 'Gengar',
      attackerLevel: 78,
      attackerAbility: 'Cursed Body',
      defenderSpecies: 'Blissey',
      defenderLevel: 84,
      defenderAbility: 'Natural Cure',
      defenderItem: 'Leftovers',
      move: 'Shadow Ball',
      observed: 0,
      tolerance: 0,
    };
    const plain = rollsFor({ ...shared, attackerItem: undefined });
    const orb = rollsFor({ ...shared, attackerItem: 'Life Orb' });
    const specs = rollsFor({ ...shared, attackerItem: 'Choice Specs' });
    const plainMax = Math.max(0, ...plain);
    const specsMin = specs.length ? Math.min(...specs) : Infinity;
    const observed = orb.find(roll => roll > plainMax && roll < specsMin);
    if (!observed) return;
    const before = probabilityOf(model.itemDistribution('Gengar'), 'Life Orb');
    model.noteDamage({
      foeSpecies: 'Gengar',
      foeIsAttacker: true,
      move: 'Shadow Ball',
      otherSpecies: 'Blissey',
      otherLevel: 84,
      otherAbility: 'Natural Cure',
      otherItem: 'Leftovers',
      observed,
      tolerance: 0,
    });
    expect(probabilityOf(model.itemDistribution('Gengar'), 'Life Orb')).toBeGreaterThan(before);
  });

  it('samples concrete teams that obey species and type limits', () => {
    const model = foe();
    model.addFoe('Pelipper', 83);
    model.addFoe('Wingull', 90);
    const worlds = sampleWorlds(model, 8);
    expect(worlds.length).toBeGreaterThan(0);
    expect(worlds.reduce((sum, world) => sum + world.weight, 0)).toBeCloseTo(1, 5);
    for (const world of worlds) {
      expect(world.team.length).toBe(6);
      const species = world.team.map(mon => mon.species);
      expect(new Set(species).size).toBe(species.length);
      expect(species).not.toContain('Tentacruel');
      expect(species[0]).toBe('Pelipper');
      const set = toPokemonSet(world.team[0]);
      expect(set.species).toBe('Pelipper');
      expect(set.moves.length).toBeGreaterThan(0);
    }
    const again = new SetInference(fixture, { ourSide: () => 'p1', seed: 2 });
    again.addFoe('Pelipper', 83);
    again.addFoe('Wingull', 90);
    expect(sampleWorlds(again, 8).map(world => world.tag)).toEqual(worlds.map(world => world.tag));
    expect(probabilityOf(model.teammateDistribution(), 'Tentacruel')).toBe(0);
    expect(probabilityOf(model.teammateDistribution(), 'Gengar')).toBeGreaterThan(0);
  });

  it('reads Rocky Helmet from the [of] holder, not the pokemon who took the hit', () => {
    const model = foe();
    model.observe('|switch|p1a: Pelipper|Pelipper, L83|100/100');
    model.observe('|switch|p2a: Ampharos|Ampharos, L88|100/100');
    const theirs = '|-damage|p1a: Pelipper|90/100|[from] item: Rocky Helmet|[of] p2a: Ampharos';
    expect(model.upcoming(theirs)).toEqual({ kind: 'item', species: 'Ampharos', truth: 'Rocky Helmet' });
    model.observe(theirs);
    expect(probabilityOf(model.itemDistribution('Ampharos'), 'Rocky Helmet')).toBe(1);
    const ours = '|-damage|p2a: Ampharos|90/100|[from] item: Rocky Helmet|[of] p1a: Pelipper';
    expect(model.upcoming(ours)).toBeNull();
  });

  it('puts the revealed Tera type at probability 1', () => {
    const model = foe();
    model.observe('|switch|p2a: Ampharos|Ampharos, L88|100/100');
    expect(probabilityOf(model.teraDistribution('Ampharos'), 'Fairy')).toBeGreaterThan(0);
    const event = model.upcoming('|-terastallize|p2a: Ampharos|Electric');
    expect(event?.truth).toBe('Electric');
    model.observe('|-terastallize|p2a: Ampharos|Electric');
    expect(probabilityOf(model.teraDistribution('Ampharos'), 'Electric')).toBe(1);
  });

  it('writes the role posterior onto the shared belief tracker', () => {
    const beliefs = new BeliefTracker(fixture);
    const model = new SetInference(fixture, { ourSide: () => 'p1', beliefs });
    model.addFoe('Ampharos', 88);
    model.seeMove('Ampharos', 'Agility');
    const belief = beliefs.getBelief('p2:Ampharos');
    expect(belief?.revealedMoves.has('Agility')).toBe(true);
    expect(belief?.possibleSets.get('AV Pivot') || 0).toBe(0);
    expect(belief?.possibleSets.get('Wallbreaker') || 0).toBeGreaterThan(0.9);
  });

  it('fills world-builder states from sampleWorlds', () => {
    const model = foe();
    model.addFoe('Pelipper', 83);
    model.addFoe('Wingull', 90);
    const state: GameState = {
      myTeam: [],
      opponentTeam: [],
      myActive: 0,
      opponentActive: 0,
      turn: 1,
      myTeraUsed: false,
      opponentTeraUsed: false,
      field: { trickRoom: false, screens: {} },
      hazards: {
        my: { stealthRock: false, spikes: 0, toxicSpikes: 0 },
        opponent: { stealthRock: false, spikes: 0, toxicSpikes: 0 },
      },
    };
    const worlds = new WorldBuilder(gen9RandomBattle).buildWorlds(state, 4, model);
    expect(worlds).toHaveLength(4);
    expect(worlds[0].opponentTeam[0].species).toBe('Pelipper');
    expect(worlds[0].opponentTeam).toHaveLength(6);
  });

  it('does not create or overwrite data/gen9-stats.json', () => {
    const file = path.join(process.cwd(), 'data', 'gen9-stats.json');
    const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
    const model = foe();
    model.addFoe('Ampharos', 88);
    model.sampleWorlds(2);
    const after = fs.existsSync(file) ? fs.readFileSync(file) : null;
    expect(after).toEqual(before);
  });
});
