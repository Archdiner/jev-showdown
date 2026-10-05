import { describe, expect, it } from '@jest/globals';
import { SetInference, probabilityOf } from './index.js';
import { randbatsStat } from './catalog.js';
import type { RandbatsStats, RoleData } from '../../types/index.js';

/**
 * Evidence updates that tighten a foe's set posterior (port of #82's
 * evidence-updater tests, made to assert). Speed order, hard filters and
 * damage caps are default SetInference behaviour; the weather-duration rock
 * is the opt-in `beliefUpdaterEnabled` layer. Unit fixture only: production
 * reads the 509-species randbats table.
 */

function role(
  weight: number,
  moves: Record<string, number>,
  items: Record<string, number>,
  ability: string,
): RoleData {
  return { weight, moves, items, teraTypes: { Normal: 1 }, abilities: { [ability]: 1 } };
}

function species(level: number, ability: string, roles: Record<string, RoleData>) {
  const items: Record<string, number> = {};
  for (const data of Object.values(roles)) {
    for (const [item, p] of Object.entries(data.items || {})) items[item] = (items[item] || 0) + p * data.weight;
  }
  return { level, abilities: { [ability]: 1 }, items, roles };
}

const stats: RandbatsStats = {
  Garchomp: species(84, 'Rough Skin', {
    'Bulky Setup': role(0.5, { Earthquake: 1, 'Stone Edge': 1, 'Swords Dance': 1, 'Stealth Rock': 0.5 }, { 'Loaded Dice': 0.5, 'Life Orb': 0.5 }, 'Rough Skin'),
    'Choice Item': role(0.5, { Earthquake: 1, Outrage: 1, 'Stone Edge': 1, 'Fire Fang': 1 }, { 'Choice Scarf': 0.5, 'Choice Band': 0.5 }, 'Rough Skin'),
  }),
  Slowbro: species(86, 'Regenerator', {
    'AV Pivot': role(0.5, { Scald: 1, 'Future Sight': 1, 'Ice Beam': 1, 'Body Press': 1 }, { 'Assault Vest': 1 }, 'Regenerator'),
    Wall: role(0.5, { Scald: 1, 'Slack Off': 1, 'Thunder Wave': 1, 'Ice Beam': 0.5 }, { 'Heavy-Duty Boots': 0.5, Leftovers: 0.5 }, 'Regenerator'),
  }),
  Pelipper: species(86, 'Drizzle', {
    'Rain Setter': role(1, { Hurricane: 1, Surf: 0.75, 'U-turn': 0.75, Roost: 0.75, 'Rain Dance': 0.75 }, { 'Damp Rock': 0.4, 'Heavy-Duty Boots': 0.6 }, 'Drizzle'),
  }),
  Snorlax: species(84, 'Thick Fat', {
    Bulky: role(1, { 'Body Slam': 1, Earthquake: 1, Rest: 1, Curse: 1 }, { Leftovers: 1 }, 'Thick Fat'),
  }),
};

const p = (inference: SetInference, mon: string, item: string) => probabilityOf(inference.itemDistribution(mon), item);

describe('speed-order evidence', () => {
  const plain = randbatsStat(102, 84);

  it('raises Choice Scarf when the foe outspeeds a mon its plain speed cannot', () => {
    const inference = new SetInference(stats);
    inference.addFoe('Garchomp', 84);
    const before = p(inference, 'Garchomp', 'Choice Scarf');
    inference.noteSpeed({ species: 'Garchomp', foeMovedFirst: true, ourSpeed: plain + 20 });
    expect(p(inference, 'Garchomp', 'Choice Scarf')).toBeGreaterThan(0.8);
    expect(p(inference, 'Garchomp', 'Choice Scarf')).toBeGreaterThan(before);
  });

  it('drops Choice Scarf when the foe moves second where Scarf would have been faster', () => {
    const inference = new SetInference(stats);
    inference.addFoe('Garchomp', 84);
    inference.noteSpeed({ species: 'Garchomp', foeMovedFirst: false, ourSpeed: plain + 20 });
    expect(p(inference, 'Garchomp', 'Choice Scarf')).toBeLessThan(0.02);
  });

  it('ignores an order both speeds explain', () => {
    const inference = new SetInference(stats);
    inference.addFoe('Garchomp', 84);
    const before = inference.itemDistribution('Garchomp');
    inference.noteSpeed({ species: 'Garchomp', foeMovedFirst: true, ourSpeed: 50 });
    expect(inference.itemDistribution('Garchomp')).toEqual(before);
  });

  it('reverses under Trick Room', () => {
    const inference = new SetInference(stats);
    inference.addFoe('Garchomp', 84);
    inference.noteSpeed({ species: 'Garchomp', foeMovedFirst: false, ourSpeed: plain + 20, trickRoom: true });
    expect(p(inference, 'Garchomp', 'Choice Scarf')).toBeGreaterThan(0.8);
  });
});

describe('hard filters', () => {
  it('a status move rules out Assault Vest', () => {
    const inference = new SetInference(stats);
    inference.addFoe('Slowbro', 86);
    expect(p(inference, 'Slowbro', 'Assault Vest')).toBeCloseTo(0.5, 5);
    inference.seeMove('Slowbro', 'Thunder Wave');
    expect(p(inference, 'Slowbro', 'Assault Vest')).toBe(0);
  });

  it('two different moves in one stint rule out Choice items', () => {
    const inference = new SetInference(stats);
    inference.observe('|switch|p2a: Garchomp|Garchomp, L84|100/100');
    inference.observe('|move|p2a: Garchomp|Earthquake|p1a: Snorlax');
    inference.observe('|turn|2');
    inference.observe('|move|p2a: Garchomp|Stone Edge|p1a: Snorlax');
    expect(p(inference, 'Garchomp', 'Choice Scarf') + p(inference, 'Garchomp', 'Choice Band')).toBe(0);
  });

  it('a switch resets the Choice lock', () => {
    const inference = new SetInference(stats);
    inference.observe('|switch|p2a: Garchomp|Garchomp, L84|100/100');
    inference.observe('|move|p2a: Garchomp|Earthquake|p1a: Snorlax');
    inference.observe('|switch|p2a: Slowbro|Slowbro, L86|100/100');
    inference.observe('|switch|p2a: Garchomp|Garchomp, L84|100/100');
    inference.observe('|move|p2a: Garchomp|Stone Edge|p1a: Snorlax');
    expect(p(inference, 'Garchomp', 'Choice Scarf')).toBeGreaterThan(0.1);
  });

  it('hazard damage rules out Heavy-Duty Boots', () => {
    const inference = new SetInference(stats);
    inference.addFoe('Slowbro', 86);
    inference.noteHazard('Slowbro', 'Stealth Rock');
    expect(p(inference, 'Slowbro', 'Heavy-Duty Boots')).toBe(0);
  });

  it('a knocked-off item is the original item', () => {
    const inference = new SetInference(stats);
    inference.observe('|switch|p2a: Garchomp|Garchomp, L84|100/100');
    inference.observe('|-enditem|p2a: Garchomp|Choice Band|[from] move: Knock Off|[of] p1a: Snorlax');
    expect(inference.getMonEvidence('Garchomp')?.revealedItem).toBe('Choice Band');
  });
});

describe('Trick / Switcheroo (opt-in belief updater)', () => {
  const trick = [
    '|switch|p1a: Snorlax|Snorlax, L84|100/100',
    '|switch|p2a: Garchomp|Garchomp, L84|100/100',
    '|move|p2a: Garchomp|Trick|p1a: Snorlax',
    '|-activate|p2a: Garchomp|move: Trick|[of] p1a: Snorlax',
    '|-item|p1a: Snorlax|Choice Scarf|[from] move: Trick',
    '|-item|p2a: Garchomp|Leftovers|[from] move: Trick',
  ];

  it('reads the item we received as the foe original, not the one it received', () => {
    const inference = new SetInference(stats, { beliefUpdaterEnabled: true });
    inference.observeLog(trick);
    expect(inference.getMonEvidence('Garchomp')?.revealedItem).toBe('Choice Scarf');
  });

  it('keeps the legacy read when off', () => {
    const inference = new SetInference(stats);
    inference.observeLog(trick);
    expect(inference.getMonEvidence('Garchomp')?.revealedItem).toBe('Leftovers');
  });
});

describe('damage-roll evidence', () => {
  it('caps item updates at two per mon', () => {
    const inference = new SetInference(stats);
    inference.addFoe('Garchomp', 84);
    inference.seeAbility('Garchomp', 'Rough Skin');
    const obs = {
      foeSpecies: 'Garchomp',
      foeIsAttacker: true,
      move: 'Earthquake',
      otherSpecies: 'Snorlax',
      otherLevel: 84,
      otherAbility: 'Thick Fat',
      otherItem: 'Leftovers',
      tolerance: 2,
    };
    const after: string[] = [];
    for (const observed of [120, 125, 118]) {
      inference.noteDamage({ ...obs, observed });
      after.push(JSON.stringify(inference.itemDistribution('Garchomp')));
    }
    expect(after[2]).toBe(after[1]);
  });
});

function rainLog(upkeeps: number, setter: 'ability' | 'move' | 'ours'): string[] {
  const lines = [
    '|switch|p1a: Snorlax|Snorlax, L84|100/100',
    '|switch|p2a: Pelipper|Pelipper, L86|100/100',
  ];
  if (setter === 'ability') lines.push('|-weather|RainDance|[from] ability: Drizzle|[of] p2a: Pelipper');
  if (setter === 'move') lines.push('|move|p2a: Pelipper|Rain Dance|p2a: Pelipper', '|-weather|RainDance');
  if (setter === 'ours') lines.push('|move|p1a: Snorlax|Rain Dance|p1a: Snorlax', '|-weather|RainDance');
  lines.push('|turn|1');
  for (let i = 0; i < upkeeps; i++) {
    lines.push('|move|p2a: Pelipper|Hurricane|p1a: Snorlax', '|-weather|RainDance|[upkeep]', '|upkeep', `|turn|${i + 2}`);
  }
  return lines;
}

describe('weather duration (opt-in belief updater)', () => {
  it('marks Damp Rock once foe rain outlasts five turns', () => {
    const inference = new SetInference(stats, { beliefUpdaterEnabled: true });
    inference.observeLog(rainLog(5, 'ability'));
    expect(p(inference, 'Pelipper', 'Damp Rock')).toBeGreaterThan(0.9);
  });

  it('also tracks a foe weather move', () => {
    const inference = new SetInference(stats, { beliefUpdaterEnabled: true });
    inference.observeLog(rainLog(5, 'move'));
    expect(p(inference, 'Pelipper', 'Damp Rock')).toBeGreaterThan(0.9);
  });

  it('says nothing about weather a normal five-turn rain explains', () => {
    const inference = new SetInference(stats, { beliefUpdaterEnabled: true });
    inference.observeLog(rainLog(4, 'ability'));
    expect(p(inference, 'Pelipper', 'Damp Rock')).toBeCloseTo(0.4, 5);
  });

  it('ignores weather our side set', () => {
    const inference = new SetInference(stats, { beliefUpdaterEnabled: true });
    inference.observeLog(rainLog(7, 'ours'));
    expect(p(inference, 'Pelipper', 'Damp Rock')).toBeCloseTo(0.4, 5);
  });

  it('is off by default: the posterior is identical to an unset option', () => {
    const lines = rainLog(7, 'ability');
    const unset = new SetInference(stats);
    const off = new SetInference(stats, { beliefUpdaterEnabled: false });
    unset.observeLog(lines);
    off.observeLog(lines);
    expect(p(unset, 'Pelipper', 'Damp Rock')).toBeCloseTo(0.4, 5);
    for (const mon of ['Pelipper']) {
      expect(off.itemDistribution(mon)).toEqual(unset.itemDistribution(mon));
      expect(off.roleDistribution(mon)).toEqual(unset.roleDistribution(mon));
      expect(off.moveInclusion(mon)).toEqual(unset.moveInclusion(mon));
    }
  });

  it('never runs for the prior-only model', () => {
    const inference = new SetInference(stats, { beliefUpdaterEnabled: true, priorOnly: true });
    expect(inference.beliefUpdaterEnabled).toBe(false);
  });
});
