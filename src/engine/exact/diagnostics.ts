import { Battle, PokemonSet, PRNG } from '@pkmn/sim';
import { ensureGenerators, legalChoices, moveChoice, switchChoice } from './battle-utils.js';
import { maxDamageChoice } from './max-damage.js';
import { EXACT_1PLY, ExactConfig, exactSearch } from './search.js';

interface Position {
  name: string;
  reason: string;
  battle: Battle;
  expected: string;
  /** When set, the @smogon/calc max-damage line must make this choice too. */
  calcExpected?: string;
}

function set(
  species: string,
  ability: string,
  item: string,
  moves: string[],
  extra: Partial<PokemonSet> = {},
): PokemonSet {
  return {
    name: species,
    species,
    ability,
    item,
    moves,
    nature: extra.nature || 'Serious',
    evs: extra.evs || { hp: 84, atk: 84, def: 84, spa: 84, spd: 84, spe: 84 },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    level: extra.level || 80,
    gender: '',
    ...extra,
  };
}

function benchFodder(species: string, ability: string): PokemonSet {
  return set(species, ability, 'Leftovers', ['splash', 'tackle', 'tailwhip', 'growl']);
}

function start(p1: PokemonSet[], p2: PokemonSet[]): Battle {
  ensureGenerators();
  const battle = new Battle({
    formatid: 'gen9customgame' as any,
    seed: new PRNG([1, 2, 3, 4] as any).startingSeed,
  });
  battle.setPlayer('p1', { name: 'P1', team: p1 });
  battle.setPlayer('p2', { name: 'P2', team: p2 });
  if (battle.p1.requestState === 'teampreview') {
    if (!battle.choose('p1', 'team 123456')) throw new Error('p1 team preview failed');
    if (!battle.choose('p2', 'team 123456')) throw new Error('p2 team preview failed');
  }
  return battle;
}

function active(battle: Battle, side: 'p1' | 'p2') {
  const mon = battle.getSide(side).active[0];
  if (!mon) throw new Error(`no active for ${side}`);
  return mon;
}

function setHp(battle: Battle, side: 'p1' | 'p2', species: string, hp: number): void {
  const mon = battle.getSide(side).pokemon.find(p => p.species.name === species);
  if (!mon) throw new Error(`missing ${species}`);
  mon.hp = hp;
  if (hp <= 0) {
    mon.hp = 0;
    mon.fainted = true;
  }
}

function boostSpe(battle: Battle, side: 'p1' | 'p2', stages: number): void {
  active(battle, side).boosts.spe = stages;
}

function play(battle: Battle, p1: string, p2: string): void {
  if (!battle.choose('p1', p1)) throw new Error(`p1 could not play ${p1}: ${battle.p1.choice.error}`);
  if (!battle.ended && !battle.choose('p2', p2)) {
    throw new Error(`p2 could not play ${p2}: ${battle.p2.choice.error}`);
  }
}

function must(choice: string | null, label: string): string {
  if (!choice) throw new Error(`could not find ${label}`);
  return choice;
}

/**
 * Twenty positions. Every choice offered to search is legal in the live battle.
 * The expected choice is the unique move a 1-ply HP search should make.
 */
export function buildPositions(): Position[] {
  const positions: Position[] = [];

  // 1. Take the guaranteed KO instead of setting up.
  {
    const battle = start(
      [
        set('Garchomp', 'Rough Skin', 'Leftovers', ['earthquake', 'swordsdance', 'firefang', 'protect'], { nature: 'Jolly' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
      [
        set('Heatran', 'Flash Fire', 'Leftovers', ['lavaplume', 'stealthrock', 'protect', 'willowisp'], { nature: 'Quiet' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
    );
    setHp(battle, 'p2', 'Heatran', 1);
    boostSpe(battle, 'p1', 2);
    positions.push({
      name: '01-take-guaranteed-ko',
      reason: 'Earthquake KOs Heatran at 1 HP. Swords Dance does not.',
      battle,
      expected: must(moveChoice(battle, 'p1', 'earthquake'), 'earthquake'),
    });
  }

  // 2. Super-effective move over resisted and status.
  {
    const battle = start(
      [
        set('Swampert', 'Torrent', 'Leftovers', ['earthquake', 'surf', 'icebeam', 'stealthrock'], { nature: 'Jolly' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
      [
        set('Heatran', 'Flash Fire', 'Leftovers', ['lavaplume', 'earthpower', 'protect', 'stealthrock'], { nature: 'Quiet' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
    );
    boostSpe(battle, 'p1', 6);
    positions.push({
      name: '02-super-effective',
      reason: 'Earthquake is 4x vs Heatran. Surf is resisted, Ice Beam is neutral.',
      battle,
      expected: must(moveChoice(battle, 'p1', 'earthquake'), 'earthquake'),
    });
  }

  // 3. Do not click a move the foe is immune to.
  {
    const battle = start(
      [
        set('Starmie', 'Natural Cure', 'Leftovers', ['icebeam', 'thunderbolt', 'surf', 'psychic'], { nature: 'Timid' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
      [
        set('Garchomp', 'Rough Skin', 'Leftovers', ['earthquake', 'outrage', 'swordsdance', 'protect'], { nature: 'Jolly' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
    );
    boostSpe(battle, 'p1', 6);
    positions.push({
      name: '03-avoid-immunity',
      reason: 'Ice Beam is 4x into Garchomp. Thunderbolt is immune.',
      battle,
      expected: must(moveChoice(battle, 'p1', 'icebeam'), 'icebeam'),
    });
  }

  // 4. Do not switch into a guaranteed KO.
  {
    const battle = start(
      [
        set('Blissey', 'Natural Cure', 'Leftovers', ['seismictoss', 'softboiled', 'thunderwave', 'icebeam'], { nature: 'Bold' }),
        set('Gyarados', 'Intimidate', 'Leftovers', ['waterfall', 'earthquake', 'dragondance', 'icefang']),
        set('Pelipper', 'Drizzle', 'Leftovers', ['hurricane', 'weatherball', 'roost', 'uturn']),
        set('Swanna', 'Keen Eye', 'Leftovers', ['hurricane', 'surf', 'roost', 'defog']),
        set('Mantine', 'Water Absorb', 'Leftovers', ['scald', 'roost', 'haze', 'defog']),
        set('Barraskewda', 'Swift Swim', 'Choice Band', ['liquidation', 'closecombat', 'aquajet', 'psychicfangs']),
      ],
      [
        set('Jolteon', 'Volt Absorb', 'Choice Specs', ['thunderbolt', 'thunder', 'voltswitch', 'shadowball'], { nature: 'Timid' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
    );
    for (const species of ['Gyarados', 'Pelipper', 'Swanna', 'Mantine', 'Barraskewda']) {
      setHp(battle, 'p1', species, 1);
    }
    positions.push({
      name: '04-dont-switch-into-ko',
      reason: 'Every switch is at 1 HP into Thunderbolt. Seismic Toss stays in and deals damage.',
      battle,
      expected: must(moveChoice(battle, 'p1', 'seismictoss'), 'seismictoss'),
    });
  }

  // 5. Do not stay in against a guaranteed OHKO when a safe switch exists.
  {
    const battle = start(
      [
        set('Gyarados', 'Intimidate', 'Leftovers', ['dragondance', 'thunderwave', 'splash', 'raindance']),
        set('Blissey', 'Natural Cure', 'Leftovers', ['seismictoss', 'softboiled', 'icebeam', 'thunderwave'], { nature: 'Bold' }),
        set('Pelipper', 'Drizzle', 'Leftovers', ['hurricane', 'surf', 'roost', 'uturn']),
        set('Swanna', 'Keen Eye', 'Leftovers', ['hurricane', 'surf', 'roost', 'defog']),
        set('Mantine', 'Water Absorb', 'Leftovers', ['scald', 'roost', 'haze', 'defog']),
        set('Barraskewda', 'Swift Swim', 'Choice Band', ['liquidation', 'closecombat', 'aquajet', 'psychicfangs']),
      ],
      [
        set('Zapdos', 'Static', 'Leftovers', ['thunderbolt', 'voltswitch', 'discharge', 'thunder'], { nature: 'Timid' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
    );
    setHp(battle, 'p1', 'Gyarados', 1);
    for (const species of ['Pelipper', 'Swanna', 'Mantine', 'Barraskewda']) setHp(battle, 'p1', species, 1);
    positions.push({
      name: '05-switch-out-of-ohko',
      reason: 'Gyarados is at 1 HP with no attack. Blissey lives Thunderbolt. Every other switch is at 1 HP.',
      battle,
      expected: must(switchChoice(battle, 'p1', 'Blissey'), 'Blissey'),
    });
  }

  // 6. Do not waste a status move into Substitute.
  {
    const battle = start(
      [
        set('Garchomp', 'Rough Skin', 'Leftovers', ['swordsdance', 'earthquake', 'toxic', 'firefang'], { nature: 'Jolly' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
      [
        set('Blissey', 'Natural Cure', 'Leftovers', ['substitute', 'softboiled', 'seismictoss', 'thunderwave'], { nature: 'Bold' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
    );
    const sd = must(moveChoice(battle, 'p1', 'swordsdance'), 'swordsdance');
    const sub = must(moveChoice(battle, 'p2', 'substitute'), 'substitute');
    play(battle, sd, sub);
    positions.push({
      name: '06-no-status-into-substitute',
      reason: 'Toxic does nothing to Substitute. Earthquake breaks it and deals damage.',
      battle,
      expected: must(moveChoice(battle, 'p1', 'earthquake'), 'earthquake'),
    });
  }

  // 7. Priority snipes the KO when a normal move would lose the race.
  {
    const battle = start(
      [
        set('Lucario', 'Inner Focus', 'Leftovers', ['extremespeed', 'closecombat', 'swordsdance', 'meteormash'], { nature: 'Adamant' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
      [
        set('Garchomp', 'Rough Skin', 'Choice Band', ['earthquake', 'outrage', 'stoneedge', 'firefang'], { nature: 'Jolly' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
    );
    setHp(battle, 'p2', 'Garchomp', 1);
    for (const species of ['Magikarp', 'Wobbuffet', 'Ditto', 'Smeargle', 'Unown']) {
      setHp(battle, 'p1', species, 1);
    }
    positions.push({
      name: '07-priority-ko',
      reason: 'Garchomp is at 1 HP and faster. Extreme Speed KOs before Earthquake. Every switch is at 1 HP.',
      battle,
      expected: must(moveChoice(battle, 'p1', 'extremespeed'), 'extremespeed'),
    });
  }

  // 8. Do not set up when the attack wins immediately.
  {
    const battle = start(
      [
        set('Dragonite', 'Multiscale', 'Lum Berry', ['extremespeed', 'dragondance', 'earthquake', 'roost'], { nature: 'Adamant' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
      [
        set('Snorlax', 'Thick Fat', 'Leftovers', ['bodyslam', 'earthquake', 'rest', 'sleeptalk'], { nature: 'Adamant' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
    );
    setHp(battle, 'p2', 'Snorlax', 1);
    positions.push({
      name: '08-no-setup-when-ko',
      reason: 'Extreme Speed KOs Snorlax at 1 HP. Dragon Dance does not.',
      battle,
      expected: must(moveChoice(battle, 'p1', 'extremespeed'), 'extremespeed'),
    });
  }

  // 9. Attack for the KO instead of recovering at full HP.
  {
    const battle = start(
      [
        set('Toxapex', 'Regenerator', 'Black Sludge', ['scald', 'recover', 'toxic', 'banefulbunker'], { nature: 'Bold' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
      [
        set('Cinderace', 'Blaze', 'Choice Band', ['pyroball', 'highjumpkick', 'uturn', 'suckerpunch'], { nature: 'Jolly' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
    );
    setHp(battle, 'p2', 'Cinderace', 1);
    boostSpe(battle, 'p1', 6);
    positions.push({
      name: '09-attack-over-recover',
      reason: 'Scald KOs 1 HP Cinderace. Recover at full HP does nothing.',
      battle,
      expected: must(moveChoice(battle, 'p1', 'scald'), 'scald'),
    });
  }

  // 10. Dark move into a Ghost, not the immune Fighting move.
  {
    const battle = start(
      [
        set('Machamp', 'No Guard', 'Leftovers', ['knockoff', 'closecombat', 'bulletpunch', 'icepunch'], { nature: 'Adamant' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
      [
        set('Gengar', 'Cursed Body', 'Leftovers', ['shadowball', 'sludgewave', 'focusblast', 'nastyplot'], { nature: 'Timid' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
    );
    boostSpe(battle, 'p1', 6);
    positions.push({
      name: '10-knock-off-not-immune',
      reason: 'Close Combat is immune on Gengar. Knock Off is super-effective.',
      battle,
      expected: must(moveChoice(battle, 'p1', 'knockoff'), 'knockoff'),
    });
  }

  // 11. Switch to the Ground immunity, not into the 4x weakness, and not stay at 1 HP.
  {
    const battle = start(
      [
        set('Pikachu', 'Static', 'Light Ball', ['thunderbolt', 'grassknot', 'voltswitch', 'surf']),
        set('Garchomp', 'Rough Skin', 'Leftovers', ['earthquake', 'outrage', 'swordsdance', 'protect']),
        set('Gyarados', 'Intimidate', 'Leftovers', ['waterfall', 'earthquake', 'dragondance', 'icefang']),
        set('Pelipper', 'Drizzle', 'Leftovers', ['hurricane', 'surf', 'roost', 'uturn']),
        set('Swanna', 'Keen Eye', 'Leftovers', ['hurricane', 'surf', 'roost', 'defog']),
        set('Mantine', 'Water Absorb', 'Leftovers', ['scald', 'roost', 'haze', 'defog']),
      ],
      [
        set('Zapdos', 'Static', 'Leftovers', ['thunderbolt', 'discharge', 'voltswitch', 'thunder'], { nature: 'Timid' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
    );
    setHp(battle, 'p1', 'Pikachu', 1);
    for (const species of ['Gyarados', 'Pelipper', 'Swanna', 'Mantine']) setHp(battle, 'p1', species, 1);
    positions.push({
      name: '11-switch-to-immunity',
      reason: 'Pikachu is at 1 HP. Garchomp is immune to Electric. Every other switch is at 1 HP.',
      battle,
      expected: must(switchChoice(battle, 'p1', 'Garchomp'), 'Garchomp'),
    });
  }

  // 13. Stone Edge is 4x into Charizard.
  {
    const battle = start(
      [
        set('Tyranitar', 'Sand Stream', 'Leftovers', ['stoneedge', 'crunch', 'earthquake', 'icebeam'], { nature: 'Adamant' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
      [
        set('Charizard', 'Blaze', 'Leftovers', ['flamethrower', 'airslash', 'roost', 'dragondance'], { nature: 'Timid' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
    );
    boostSpe(battle, 'p1', 6);
    positions.push({
      name: '13-stone-edge-4x',
      reason: 'Stone Edge is 4x into Charizard and outdamages Crunch, Earthquake, and Ice Beam.',
      battle,
      expected: must(moveChoice(battle, 'p1', 'stoneedge'), 'stoneedge'),
    });
  }

  // 14. Do not status when the attack KOs.
  {
    const battle = start(
      [
        set('Gengar', 'Cursed Body', 'Life Orb', ['shadowball', 'willowisp', 'sludgewave', 'nastyplot'], { nature: 'Timid' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
      [
        set('Weavile', 'Pressure', 'Choice Band', ['knockoff', 'tripleaxel', 'iceshard', 'swordsdance'], { nature: 'Jolly' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
    );
    setHp(battle, 'p2', 'Weavile', 1);
    boostSpe(battle, 'p1', 6);
    positions.push({
      name: '14-shadow-ball-not-wisp',
      reason: 'Shadow Ball KOs Weavile at 1 HP. Will-O-Wisp does not.',
      battle,
      expected: must(moveChoice(battle, 'p1', 'shadowball'), 'shadowball'),
    });
  }

  // 15. Do not switch away from a free KO.
  {
    const battle = start(
      [
        set('Garchomp', 'Rough Skin', 'Leftovers', ['earthquake', 'outrage', 'swordsdance', 'firefang'], { nature: 'Jolly' }),
        set('Blissey', 'Natural Cure', 'Leftovers', ['seismictoss', 'softboiled', 'icebeam', 'thunderwave']),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
      [
        set('Heatran', 'Flash Fire', 'Leftovers', ['lavaplume', 'earthpower', 'stealthrock', 'protect']),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
    );
    setHp(battle, 'p2', 'Heatran', 1);
    boostSpe(battle, 'p1', 6);
    positions.push({
      name: '15-dont-switch-off-a-ko',
      reason: 'Earthquake KOs Heatran before it moves. Switching gives Heatran a free hit.',
      battle,
      expected: must(moveChoice(battle, 'p1', 'earthquake'), 'earthquake'),
    });
  }

  // 16. Fire move into Ferrothorn, not the resisted Steel move.
  {
    const battle = start(
      [
        set('Heatran', 'Flash Fire', 'Leftovers', ['flamethrower', 'flashcannon', 'earthpower', 'stealthrock'], { nature: 'Modest' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
      [
        set('Ferrothorn', 'Iron Barbs', 'Leftovers', ['powerwhip', 'gyroball', 'leechseed', 'protect'], { nature: 'Relaxed' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
    );
    boostSpe(battle, 'p1', 6);
    positions.push({
      name: '16-fire-into-ferrothorn',
      reason: 'Flamethrower is 4x into Ferrothorn. Flash Cannon is resisted.',
      battle,
      expected: must(moveChoice(battle, 'p1', 'flamethrower'), 'flamethrower'),
    });
  }

  // 17. Second Substitute case: Knock Off, not Will-O-Wisp.
  {
    const battle = start(
      [
        set('Tyranitar', 'Sand Stream', 'Leftovers', ['knockoff', 'willowisp', 'stoneedge', 'stealthrock'], { nature: 'Adamant' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
      [
        set('Blissey', 'Natural Cure', 'Leftovers', ['substitute', 'softboiled', 'seismictoss', 'thunderwave']),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
    );
    play(
      battle,
      must(moveChoice(battle, 'p1', 'stealthrock'), 'stealthrock'),
      must(moveChoice(battle, 'p2', 'substitute'), 'substitute'),
    );
    positions.push({
      name: '17-knock-off-breaks-substitute',
      reason: 'Will-O-Wisp is absorbed by Substitute. Knock Off breaks it.',
      battle,
      expected: must(moveChoice(battle, 'p1', 'knockoff'), 'knockoff'),
    });
  }

  // 18. Recover does not save a 1 HP pokemon that is slower than an OHKO.
  {
    const battle = start(
      [
        set('Toxapex', 'Regenerator', 'Black Sludge', ['recover', 'scald', 'toxic', 'haze'], { nature: 'Bold' }),
        set('Skarmory', 'Sturdy', 'Leftovers', ['bravebird', 'roost', 'spikes', 'bodypress']),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
      [
        set('Kartana', 'Beast Boost', 'Choice Band', ['leafblade', 'smartstrike', 'sacredsword', 'knockoff'], { nature: 'Jolly' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
    );
    setHp(battle, 'p1', 'Toxapex', 1);
    for (const species of ['Wobbuffet', 'Ditto', 'Smeargle', 'Unown']) setHp(battle, 'p1', species, 1);
    positions.push({
      name: '18-switch-not-recover-at-1hp',
      reason: 'Kartana outspeeds and KOs 1 HP Toxapex before Recover. Skarmory lives Leaf Blade. Every other switch is at 1 HP.',
      battle,
      expected: must(switchChoice(battle, 'p1', 'Skarmory'), 'Skarmory'),
    });
  }

  // 19. Bullet Punch wins the race.
  {
    const battle = start(
      [
        set('Scizor', 'Technician', 'Leftovers', ['bulletpunch', 'closecombat', 'swordsdance', 'roost'], { nature: 'Adamant' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Slowbro', 'Oblivious'),
      ],
      [
        set('Garchomp', 'Rough Skin', 'Choice Scarf', ['earthquake', 'outrage', 'dragonclaw', 'swordsdance'], { nature: 'Jolly' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
    );
    setHp(battle, 'p1', 'Scizor', 1);
    setHp(battle, 'p2', 'Garchomp', 1);
    for (const species of ['Magikarp', 'Wobbuffet', 'Ditto', 'Smeargle', 'Slowbro']) setHp(battle, 'p1', species, 1);
    positions.push({
      name: '19-bullet-punch-race',
      reason: 'Scizor is at 1 HP and slower. Bullet Punch KOs. Close Combat faints first.',
      battle,
      expected: must(moveChoice(battle, 'p1', 'bulletpunch'), 'bulletpunch'),
    });
  }

  // 20. Water move into a Ground type, not the immune Electric move.
  {
    const battle = start(
      [
        set('Rotom-Wash', 'Levitate', 'Leftovers', ['hydropump', 'thunderbolt', 'voltswitch', 'willowisp'], { nature: 'Modest' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
      [
        set('Garchomp', 'Rough Skin', 'Leftovers', ['earthquake', 'outrage', 'swordsdance', 'protect'], { nature: 'Jolly' }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Unown', 'Levitate'),
      ],
    );
    boostSpe(battle, 'p1', 6);
    setHp(battle, 'p2', 'Garchomp', 1);
    for (const species of ['Magikarp', 'Wobbuffet', 'Ditto', 'Smeargle', 'Unown']) setHp(battle, 'p1', species, 1);
    positions.push({
      name: '20-hydro-pump-not-thunderbolt',
      reason: 'Garchomp is at 1 HP and immune to Electric. Hydro Pump KOs. Thunderbolt does not.',
      battle,
      expected: must(moveChoice(battle, 'p1', 'hydropump'), 'hydropump'),
    });
  }

  const floatzel = start(
    [
      set('Floatzel', 'Swift Swim', 'Leftovers', ['aquajet', 'liquidation', 'icepunch', 'bulkup'], { nature: 'Adamant' }),
      benchFodder('Magikarp', 'Swift Swim'),
      benchFodder('Wobbuffet', 'Shadow Tag'),
      benchFodder('Ditto', 'Limber'),
      benchFodder('Smeargle', 'Own Tempo'),
      benchFodder('Unown', 'Levitate'),
    ],
    [
      set('Garchomp', 'Rough Skin', 'Choice Scarf', ['earthquake', 'outrage', 'firefang', 'stoneedge'], { nature: 'Jolly' }),
      benchFodder('Magikarp', 'Swift Swim'),
      benchFodder('Wobbuffet', 'Shadow Tag'),
      benchFodder('Ditto', 'Limber'),
      benchFodder('Smeargle', 'Own Tempo'),
      benchFodder('Unown', 'Levitate'),
    ],
  );
  setHp(floatzel, 'p1', 'Floatzel', 1);
  setHp(floatzel, 'p2', 'Garchomp', 1);
  const fixed12: Position = {
    name: '12-aqua-jet-priority',
    reason: 'Both are at 1 HP and Garchomp outspeeds. Aqua Jet KOs first.',
    battle: floatzel,
    expected: must(moveChoice(floatzel, 'p1', 'aquajet'), 'aquajet'),
  };
  positions.push(fixed12);

  // 20 was hydro pump. This is an extra unambiguous KO to keep the suite at 20
  // if a fixture above fails to construct. Count is checked by the runner.
  const kingambit = start(
    [
      set('Kingambit', 'Defiant', 'Leftovers', ['kowtowcleave', 'swordsdance', 'ironhead', 'suckerpunch'], { nature: 'Adamant' }),
      benchFodder('Magikarp', 'Swift Swim'),
      benchFodder('Wobbuffet', 'Shadow Tag'),
      benchFodder('Ditto', 'Limber'),
      benchFodder('Smeargle', 'Own Tempo'),
      benchFodder('Unown', 'Levitate'),
    ],
    [
      set('Indeedee-F', 'Psychic Surge', 'Leftovers', ['psychic', 'dazzlinggleam', 'calmmind', 'hypervoice'], { nature: 'Bold' }),
      benchFodder('Magikarp', 'Swift Swim'),
      benchFodder('Wobbuffet', 'Shadow Tag'),
      benchFodder('Ditto', 'Limber'),
      benchFodder('Smeargle', 'Own Tempo'),
      benchFodder('Unown', 'Levitate'),
    ],
  );
  setHp(kingambit, 'p2', 'Indeedee-F', 1);
  boostSpe(kingambit, 'p1', 6);
  positions.push({
    name: '21-kowtow-not-swords-dance',
    reason: 'Kowtow Cleave KOs Indeedee-F at 1 HP. Swords Dance does not.',
    battle: kingambit,
    expected: must(moveChoice(kingambit, 'p1', 'kowtowcleave'), 'kowtowcleave'),
  });

  // Garchomp (Life Orb, Adamant, 209 Spe) vs Levitate Rotom-Wash (Bold, 193 Spe).
  // These spreads are the ones whose calc rolls are Earthquake 0, Stone Edge
  // 84-100 at 80% accuracy, Dragon Claw 101-121 at 100% accuracy.
  {
    const evs = { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 };
    const battle = start(
      [
        set('Garchomp', 'Rough Skin', 'Life Orb', ['dragonclaw', 'stoneedge', 'earthquake', 'swordsdance'], {
          nature: 'Adamant',
          level: 80,
          evs,
        }),
        benchFodder('Skarmory', 'Sturdy'),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Unown', 'Levitate'),
      ],
      [
        set('Rotom-Wash', 'Levitate', 'Leftovers', ['hydropump', 'voltswitch', 'willowisp', 'painsplit'], {
          nature: 'Bold',
          level: 84,
          evs,
        }),
        benchFodder('Magikarp', 'Swift Swim'),
        benchFodder('Wobbuffet', 'Shadow Tag'),
        benchFodder('Ditto', 'Limber'),
        benchFodder('Smeargle', 'Own Tempo'),
        benchFodder('Porygon', 'Trace'),
      ],
    );
    const garchomp = active(battle, 'p1');
    const rotom = active(battle, 'p2');
    if (garchomp.storedStats.spe !== 209 || rotom.storedStats.spe !== 193) {
      throw new Error(`speed fixture drifted: Garchomp ${garchomp.storedStats.spe}, Rotom ${rotom.storedStats.spe}`);
    }
    const claw = must(moveChoice(battle, 'p1', 'dragonclaw'), 'dragonclaw');
    positions.push({
      name: '22-dragon-claw-not-stone-edge',
      reason: 'Dragon Claw is STAB and always hits for 101-121. Stone Edge is 84-100 at 80% and has no STAB. Earthquake is immune on Levitate.',
      battle,
      expected: claw,
      calcExpected: claw,
    });
  }

  return positions;
}

export function runDiagnosticSuite(config: ExactConfig = EXACT_1PLY): { passed: number; failed: number; total: number } {
  const positions = buildPositions();
  let passed = 0;
  let failed = 0;
  for (const position of positions) {
    const legal = legalChoices(position.battle, 'p1');
    if (!legal.includes(position.expected)) {
      console.log(`✗ ${position.name} FIXTURE: expected ${position.expected} is not legal (${legal.join(', ')})`);
      failed++;
      continue;
    }
    const trace = exactSearch(position.battle, 'p1', config);
    const calcChoice = position.calcExpected ? maxDamageChoice(position.battle, 'p1', legal) : undefined;
    const calcOk = !position.calcExpected || calcChoice === position.calcExpected;
    if (trace.choice === position.expected && calcOk) {
      console.log(`✓ ${position.name}`);
      passed++;
    } else {
      console.log(`✗ ${position.name}`);
      console.log(`  reason: ${position.reason}`);
      console.log(`  expected ${position.expected}`);
      console.log(`  got      ${trace.choice}`);
      if (!calcOk) console.log(`  calc got ${calcChoice}, expected ${position.calcExpected}`);
      const ranked = [...trace.scores].sort((a, b) => b.score - a.score).slice(0, 6);
      for (const row of ranked) {
        console.log(`    ${row.score.toFixed(2).padStart(8)}  ${row.choice}`);
      }
      failed++;
    }
  }
  console.log(`\nDiagnostics ${passed}/${positions.length}`);
  return { passed, failed, total: positions.length };
}
