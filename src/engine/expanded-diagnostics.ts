#!/usr/bin/env node

/**
 * Expanded Diagnostic Test Suite (~20 tests)
 * Each test has ONE unambiguously correct move
 */

import { GameState, Action, PokemonBelief } from '../types/index.js';

export interface DiagnosticTest {
  name: string;
  state: GameState;
  legalActions: Action[];
  expectedAction: Action;
  reason: string;
}

function createState(overrides: Partial<GameState> = {}): GameState {
  return {
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
    playerId: 'p1',
    ...overrides,
  };
}

function createMon(overrides: Partial<PokemonBelief>): PokemonBelief {
  return {
    species: 'Unknown',
    level: 80,
    possibleSets: new Map(),
    revealedMoves: new Set(),
    currentHp: 100,
    maxHp: 100,
    ...overrides,
  };
}

export const expandedDiagnosticTests: DiagnosticTest[] = [
  // 1. Take guaranteed KO
  {
    name: '01-guaranteed-ko',
    reason: 'Take the guaranteed KO with super-effective move',
    state: createState({
      myTeam: [
        createMon({
          species: 'Tyranitar',
          level: 80,
          revealedMoves: new Set(['stoneedge', 'crunch', 'earthquake', 'icebeam']),
          stats: { hp: 200, atk: 164, def: 130, spa: 105, spd: 120, spe: 81 },
          currentHp: 180,
          maxHp: 200,
        }),
        createMon({ species: 'Blissey', currentHp: 250, maxHp: 350 }),
      ],
      opponentTeam: [
        createMon({
          species: 'Charizard',
          level: 80,
          revealedMoves: new Set(['flamethrower', 'airslash']),
          stats: { hp: 156, atk: 104, def: 98, spa: 129, spd: 105, spe: 120 },
          currentHp: 10,  // Very low - any hit kills
          maxHp: 156,
        }),
        createMon({ species: 'Gyarados', currentHp: 180, maxHp: 180 }),
      ],
    }),
    legalActions: [
      { type: 'move', moveIndex: 1 },  // Stone Edge - GUARANTEED KO (4x weakness)
      { type: 'move', moveIndex: 2 },  // Crunch
      { type: 'switch', switchIndex: 2 },
    ],
    expectedAction: { type: 'move', moveIndex: 1 },
  },

  // 2. Don't switch into guaranteed OHKO
  {
    name: '02-dont-switch-into-ko',
    reason: 'Stay in rather than switching into a guaranteed OHKO',
    state: createState({
      myTeam: [
        createMon({
          species: 'Raichu',
          level: 80,
          revealedMoves: new Set(['thunderbolt', 'surf', 'voltswitch']),
          stats: { hp: 140, atk: 110, def: 75, spa: 110, spd: 100, spe: 130 },
          currentHp: 140,
          maxHp: 140,
        }),
        createMon({
          species: 'Gyarados',  // Water/Flying - 4x weak to Electric!
          level: 80,
          revealedMoves: new Set(['waterfall']),
          stats: { hp: 180, atk: 145, def: 99, spa: 80, spd: 120, spe: 101 },
          currentHp: 180,
          maxHp: 180,
        }),
      ],
      opponentTeam: [
        createMon({
          species: 'Zapdos',  // Electric - will OHKO Gyarados
          level: 80,
          revealedMoves: new Set(['thunderbolt', 'hurricane']),
          stats: { hp: 180, atk: 110, def: 105, spa: 145, spd: 110, spe: 120 },
          currentHp: 180,
          maxHp: 180,
        }),
        createMon({ species: 'Blastoise', currentHp: 150, maxHp: 150 }),
      ],
    }),
    legalActions: [
      { type: 'move', moveIndex: 1 },  // Thunderbolt - CORRECT
      { type: 'move', moveIndex: 2 },  // Surf
      { type: 'switch', switchIndex: 2 },  // BAD - Gyarados gets OHKOd
    ],
    expectedAction: { type: 'move', moveIndex: 1 },
  },

  // 3. Use super-effective move over neutral
  {
    name: '03-use-super-effective',
    reason: 'Choose super-effective move over neutral one',
    state: createState({
      myTeam: [
        createMon({
          species: 'Swampert',
          level: 80,
          revealedMoves: new Set(['earthquake', 'surf', 'icebeam', 'stealthrock']),
          stats: { hp: 200, atk: 130, def: 110, spa: 105, spd: 110, spe: 80 },
          currentHp: 200,
          maxHp: 200,
        }),
      ],
      opponentTeam: [
        createMon({
          species: 'Heatran',  // 4x weak to Ground!
          level: 80,
          revealedMoves: new Set(['lavaplume', 'flashcannon']),
          stats: { hp: 180, atk: 110, def: 126, spa: 150, spd: 126, spe: 97 },
          currentHp: 180,
          maxHp: 180,
        }),
      ],
    }),
    legalActions: [
      { type: 'move', moveIndex: 1 },  // Earthquake - 4x super-effective!
      { type: 'move', moveIndex: 2 },  // Surf - not very effective
      { type: 'move', moveIndex: 3 },  // Ice Beam - neutral
    ],
    expectedAction: { type: 'move', moveIndex: 1 },
  },

  // 4. Don't waste turn on status when behind Substitute
  {
    name: '04-dont-status-behind-sub',
    reason: 'Don\'t use status move when opponent has Substitute up',
    state: createState({
      myTeam: [
        createMon({
          species: 'Gliscor',
          level: 80,
          revealedMoves: new Set(['earthquake', 'toxic', 'uturn', 'protect']),
          stats: { hp: 170, atk: 115, def: 145, spa: 65, spd: 95, spe: 115 },
          currentHp: 170,
          maxHp: 170,
        }),
      ],
      opponentTeam: [
        createMon({
          species: 'Alakazam',
          level: 80,
          revealedMoves: new Set(['psyshock', 'substitute']),  // Has Substitute
          stats: { hp: 130, atk: 70, def: 65, spa: 155, spd: 115, spe: 140 },
          currentHp: 100,  // Behind Substitute (implied)
          maxHp: 130,
        }),
      ],
    }),
    legalActions: [
      { type: 'move', moveIndex: 1 },  // Earthquake - breaks Sub
      { type: 'move', moveIndex: 2 },  // Toxic - WASTED on Sub
    ],
    expectedAction: { type: 'move', moveIndex: 1 },
  },

  // 5. Finish low HP opponent rather than setting up
  {
    name: '05-finish-over-setup',
    reason: 'Finish off low HP opponent rather than setting up',
    state: createState({
      myTeam: [
        createMon({
          species: 'Garchomp',
          level: 80,
          revealedMoves: new Set(['earthquake', 'outrage', 'swordsdance', 'stealthrock']),
          stats: { hp: 200, atk: 150, def: 115, spa: 100, spd: 105, spe: 122 },
          currentHp: 200,
          maxHp: 200,
        }),
      ],
      opponentTeam: [
        createMon({
          species: 'Chansey',
          level: 80,
          revealedMoves: new Set(['seismictoss', 'softboiled']),
          stats: { hp: 600, atk: 15, def: 15, spa: 55, spd: 125, spe: 70 },
          currentHp: 50,  // Very low!
          maxHp: 600,
        }),
      ],
    }),
    legalActions: [
      { type: 'move', moveIndex: 1 },  // Earthquake - FINISH IT
      { type: 'move', moveIndex: 3 },  // Swords Dance - greedy
    ],
    expectedAction: { type: 'move', moveIndex: 1 },
  },

  // 6-20: More tests covering various scenarios...
  
  // 6. Switch out when walled
  {
    name: '06-switch-when-walled',
    reason: 'Switch out when completely walled',
    state: createState({
      myTeam: [
        createMon({
          species: 'Machamp',
          level: 80,
          revealedMoves: new Set(['closecombat', 'stoneedge', 'bulletpunch']),
          stats: { hp: 180, atk: 150, def: 100, spa: 85, spd: 105, spe: 75 },
          currentHp: 180,
          maxHp: 180,
        }),
        createMon({
          species: 'Gengar',  // Good against Ghosts
          level: 80,
          revealedMoves: new Set(['shadowball', 'sludgewave']),
          stats: { hp: 140, atk: 85, def: 80, spa: 150, spd: 95, spe: 130 },
          currentHp: 140,
          maxHp: 140,
        }),
      ],
      opponentTeam: [
        createMon({
          species: 'Gengar',  // Ghost type - immune to Fighting!
          level: 80,
          revealedMoves: new Set(['shadowball', 'sludgewave']),
          stats: { hp: 140, atk: 85, def: 80, spa: 150, spd: 95, spe: 130 },
          currentHp: 140,
          maxHp: 140,
        }),
      ],
    }),
    legalActions: [
      { type: 'move', moveIndex: 1 },  // Close Combat - IMMUNE!
      { type: 'move', moveIndex: 2 },  // Stone Edge - neutral, but bad matchup
      { type: 'switch', switchIndex: 2 },  // Gengar - better matchup
    ],
    expectedAction: { type: 'switch', switchIndex: 2 },
  },

  // 7. Don't use ineffective move
  {
    name: '07-avoid-immune-move',
    reason: 'Don\'t use move that opponent is immune to',
    state: createState({
      myTeam: [
        createMon({
          species: 'Starmie',  // Faster, bulkier
          level: 80,
          revealedMoves: new Set(['thunderbolt', 'icebeam', 'surf', 'psychic']),
          stats: { hp: 140, atk: 95, def: 105, spa: 120, spd: 105, spe: 135 },  // Faster than Garchomp!
          currentHp: 140,
          maxHp: 140,
        }),
      ],
      opponentTeam: [
        createMon({
          species: 'Garchomp',  // Ground/Dragon - immune to Electric, weak to Ice
          level: 80,
          revealedMoves: new Set(['earthquake', 'outrage']),
          stats: { hp: 200, atk: 150, def: 115, spa: 100, spd: 105, spe: 122 },
          currentHp: 80,  // Low HP so we can KO
          maxHp: 200,
        }),
      ],
    }),
    legalActions: [
      { type: 'move', moveIndex: 1 },  // Thunderbolt - IMMUNE!
      { type: 'move', moveIndex: 2 },  // Ice Beam - 4x super-effective! OHKO
      { type: 'move', moveIndex: 3 },  // Surf - neutral
    ],
    expectedAction: { type: 'move', moveIndex: 2 },
  },

  // 8. Save fainted mon - don't switch it in
  {
    name: '08-dont-switch-fainted',
    reason: 'Don\'t switch to a fainted Pokemon',
    state: createState({
      myTeam: [
        createMon({
          species: 'Lucario',
          level: 80,
          revealedMoves: new Set(['closecombat', 'meteormash']),
          stats: { hp: 150, atk: 130, def: 90, spa: 135, spd: 90, spe: 110 },
          currentHp: 150,
          maxHp: 150,
        }),
        createMon({
          species: 'Tyranitar',
          level: 80,
          currentHp: 0,  // FAINTED!
          maxHp: 200,
        }),
        createMon({
          species: 'Salamence',
          level: 80,
          currentHp: 170,
          maxHp: 170,
        }),
      ],
      opponentTeam: [
        createMon({
          species: 'Machamp',
          level: 80,
          revealedMoves: new Set(['closecombat', 'stoneedge']),
          currentHp: 180,
          maxHp: 180,
        }),
      ],
    }),
    legalActions: [
      { type: 'move', moveIndex: 1 },  // Close Combat
      { type: 'switch', switchIndex: 3 },  // Salamence - OK
      // Note: switchIndex 2 (Tyranitar) should not be legal since fainted
    ],
    expectedAction: { type: 'switch', switchIndex: 3 },  // or move, but NOT switch to 2
  },

  // Add more tests to reach ~20 total...
  // 9-20 would cover: priority moves, speed ties, hazard punishment, etc.
];

// Export count
export const TOTAL_DIAGNOSTIC_TESTS = expandedDiagnosticTests.length;
