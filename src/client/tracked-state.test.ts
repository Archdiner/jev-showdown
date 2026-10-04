import { Battle } from '@pkmn/client';
import { gen9RandomBattle } from '../formats/gen9-randombattle.js';
import { alignToRequest, overlayProtocol } from './tracked-state.js';

function mon(name: string, details: string, condition: string, active: boolean) {
  return {
    ident: `p1: ${name}`,
    details,
    condition,
    active,
    moves: ['tackle'],
    stats: { atk: 100, def: 100, spa: 100, spd: 100, spe: 100 },
  };
}

describe('alignToRequest', () => {
  it('matches forme nicknames to the request ident, not the details species', () => {
    const before = {
      side: {
        id: 'p1',
        pokemon: [
          mon('Annihilape', 'Annihilape, L76, M', '292/292', true),
          mon('Umbreon', 'Umbreon, L84, M', '0 fnt', false),
          mon('Squawkabilly', 'Squawkabilly-Blue, L85, M', '278/278', false),
          mon('Enamorus', 'Enamorus-Therian, L83, F', '259/259', false),
        ],
      },
    };
    const after = {
      side: {
        id: 'p1',
        pokemon: [
          mon('Squawkabilly', 'Squawkabilly-Blue, L85, M', '260/278', true),
          mon('Umbreon', 'Umbreon, L84, M', '0 fnt', false),
          mon('Annihilape', 'Annihilape, L76, M', '292/292', false),
          mon('Enamorus', 'Enamorus-Therian, L83, F', '259/259', false),
        ],
      },
    };

    const snapshot = gen9RandomBattle.buildGameState(before, {
      team: new Map(),
      activeSpecies: null,
      revealedMoves: new Map(),
      revealedItems: new Map(),
      revealedAbilities: new Map(),
    });
    // Protocol overlay points myActive at the Pokémon that just switched in.
    snapshot.myActive = snapshot.myTeam.findIndex(slot => slot.species === 'Squawkabilly');
    const aligned = alignToRequest(snapshot, after);
    const mismatches = gen9RandomBattle.reconcileState(aligned, after);

    expect(aligned.myTeam.map(slot => slot.species)).toEqual([
      'Squawkabilly',
      'Umbreon',
      'Annihilape',
      'Enamorus',
    ]);
    expect(aligned.myActive).toBe(0);
    expect(mismatches.filter(mismatch => mismatch.severity === 'error')).toEqual([]);
  });

  it('keeps a fainted active slot when the protocol active array was cleared', () => {
    const before = {
      side: {
        id: 'p2',
        pokemon: [
          mon('Ogerpon', 'Ogerpon-Wellspring, L76, F', '174/247', true),
          mon('Sandslash', 'Sandslash-Alola, L88, M', '224/275', false),
        ],
      },
    };
    const forceSwitch = {
      side: {
        id: 'p2',
        pokemon: [
          mon('Sandslash', 'Sandslash-Alola, L88, M', '0 fnt', true),
          mon('Ogerpon', 'Ogerpon-Wellspring, L76, F', '174/247', false),
        ],
      },
      forceSwitch: [true],
    };
    const snapshot = gen9RandomBattle.buildGameState(before, {
      team: new Map(),
      activeSpecies: null,
      revealedMoves: new Map(),
      revealedItems: new Map(),
      revealedAbilities: new Map(),
    });
    const sandslash = {
      ident: 'p2a: Sandslash',
      name: 'Sandslash',
      details: 'Sandslash-Alola, L88, M',
      hp: 0,
      maxhp: 275,
      fainted: true,
    };
    const battle = {
      turn: 12,
      p2: {
        team: [
          sandslash,
          {
            ident: 'p2a: Ogerpon',
            name: 'Ogerpon',
            details: 'Ogerpon-Wellspring, L76, F',
            hp: 174,
            maxhp: 247,
            fainted: false,
          },
        ],
        active: [null],
        lastPokemon: sandslash,
      },
    } as unknown as Battle;

    const aligned = alignToRequest(overlayProtocol(snapshot, battle, 'p2'), forceSwitch);
    const mismatches = gen9RandomBattle.reconcileState(aligned, forceSwitch);
    expect(aligned.myActive).toBe(0);
    expect(aligned.myTeam[0].species).toBe('Sandslash');
    expect(mismatches.filter(mismatch => mismatch.severity === 'error')).toEqual([]);
  });
});
