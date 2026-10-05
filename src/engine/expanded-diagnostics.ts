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

  // 9. Priority move wins speed tie
  {
    name: '09-priority-move',
    reason: 'Use priority move when outsped and about to faint',
    state: createState({
      myTeam: [
        createMon({
          species: 'Lucario',
          level: 80,
          revealedMoves: new Set(['closecombat', 'extremespeed', 'meteormash']),
          stats: { hp: 150, atk: 130, def: 90, spa: 135, spd: 90, spe: 110 },
          currentHp: 30,  // Low HP
          maxHp: 150,
        }),
      ],
      opponentTeam: [
        createMon({
          species: 'Garchomp',
          level: 80,
          revealedMoves: new Set(['earthquake']),
          stats: { hp: 200, atk: 150, def: 115, spa: 100, spd: 105, spe: 122 },  // Faster
          currentHp: 50,  // Also low
          maxHp: 200,
        }),
      ],
    }),
    legalActions: [
      { type: 'move', moveIndex: 1 },  // Close Combat - will move second, we die first
      { type: 'move', moveIndex: 2 },  // Extreme Speed - PRIORITY! Moves first, we win
    ],
    expectedAction: { type: 'move', moveIndex: 2 },
  },

  // 10. Don't set up when opponent can KO
  {
    name: '10-dont-setup-when-threatened',
    reason: 'Don\'t set up if opponent can KO you next turn',
    state: createState({
      myTeam: [
        createMon({
          species: 'Salamence',
          level: 80,
          revealedMoves: new Set(['outrage', 'dragondance', 'earthquake']),
          stats: { hp: 180, atk: 155, def: 100, spa: 130, spd: 100, spe: 120 },
          currentHp: 60,  // Low HP
          maxHp: 180,
        }),
      ],
      opponentTeam: [
        createMon({
          species: 'Weavile',  // Has Ice Shard - priority Ice move, 4x vs Salamence
          level: 80,
          revealedMoves: new Set(['iceshard', 'knockoff']),
          stats: { hp: 140, atk: 140, def: 85, spa: 65, spd: 105, spe: 145 },
          currentHp: 140,
          maxHp: 140,
        }),
      ],
    }),
    legalActions: [
      { type: 'move', moveIndex: 1 },  // Outrage - attack NOW
      { type: 'move', moveIndex: 2 },  // Dragon Dance - GREEDY, we die to Ice Shard
    ],
    expectedAction: { type: 'move', moveIndex: 1 },
  },

  // 11-20: More varied scenarios
  {
    name: '11-switch-on-predicted-switch',
    reason: 'Take advantage when opponent is likely to switch',
    state: createState({
      myTeam: [
        createMon({
          species: 'Scizor',
          level: 80,
          revealedMoves: new Set(['bulletpunch', 'uturn', 'swordsdance']),
          stats: { hp: 150, atk: 150, def: 120, spa: 75, spd: 100, spe: 85 },
          currentHp: 150,
          maxHp: 150,
        }),
        createMon({
          species: 'Heatran',
          level: 80,
          revealedMoves: new Set(['lavaplume']),
          currentHp: 180,
          maxHp: 180,
        }),
      ],
      opponentTeam: [
        createMon({
          species: 'Ferrothorn',  // Walls Scizor, will likely stay
          level: 80,
          revealedMoves: new Set(['powerwhip', 'gyroball']),
          stats: { hp: 170, atk: 114, def: 151, spa: 74, spd: 136, spe: 40 },
          currentHp: 170,
          maxHp: 170,
        }),
      ],
    }),
    legalActions: [
      { type: 'move', moveIndex: 1 },  // Bullet Punch - weak
      { type: 'move', moveIndex: 2 },  // U-turn - scout and gain momentum
      { type: 'switch', switchIndex: 2 },  // Switch to Heatran
    ],
    expectedAction: { type: 'switch', switchIndex: 2 },  // Direct switch better than U-turn damage
  },

  {
    name: '12-preserve-cleaner',
    reason: 'Don\'t risk your win condition early',
    state: createState({
      myTeam: [
        createMon({
          species: 'Blissey',
          level: 80,
          revealedMoves: new Set(['seismictoss', 'softboiled']),
          stats: { hp: 600, atk: 30, def: 30, spa: 95, spd: 155, spe: 75 },
          currentHp: 400,
          maxHp: 600,
        }),
        createMon({
          species: 'Dragonite',  // Our win condition vs their team
          level: 80,
          revealedMoves: new Set(['extremespeed', 'earthquake']),
          stats: { hp: 180, atk: 154, def: 115, spa: 120, spd: 120, spe: 100 },
          currentHp: 180,
          maxHp: 180,
        }),
      ],
      opponentTeam: [
        createMon({
          species: 'Machamp',  // Threatens Dragonite
          level: 80,
          revealedMoves: new Set(['closecombat', 'stoneedge']),
          stats: { hp: 180, atk: 150, def: 100, spa: 85, spd: 105, spe: 75 },
          currentHp: 100,
          maxHp: 180,
        }),
      ],
    }),
    legalActions: [
      { type: 'move', moveIndex: 1 },  // Seismic Toss - safe, chip damage
      { type: 'switch', switchIndex: 2 },  // Dragonite - RISKY, Stone Edge threatens
    ],
    expectedAction: { type: 'move', moveIndex: 1 },
  },

  {
    name: '13-revenge-kill',
    reason: 'Come in and revenge kill after teammate faints',
    state: createState({
      myTeam: [
        createMon({
          species: 'Gengar',
          level: 80,
          revealedMoves: new Set(['shadowball', 'sludgewave']),
          currentHp: 0,  // Fainted
          maxHp: 140,
        }),
        createMon({
          species: 'Scizor',  // Revenge killer
          level: 80,
          revealedMoves: new Set(['bulletpunch', 'uturn']),
          stats: { hp: 150, atk: 150, def: 120, spa: 75, spd: 100, spe: 85 },
          currentHp: 150,
          maxHp: 150,
        }),
      ],
      opponentTeam: [
        createMon({
          species: 'Alakazam',  // Low HP, can be revenge killed
          level: 80,
          revealedMoves: new Set(['psyshock']),
          stats: { hp: 130, atk: 70, def: 65, spa: 155, spd: 115, spe: 140 },
          currentHp: 20,  // Very low
          maxHp: 130,
        }),
      ],
    }),
    legalActions: [
      { type: 'switch', switchIndex: 2 },  // Scizor - CORRECT, revenge kill with Bullet Punch
    ],
    expectedAction: { type: 'switch', switchIndex: 2 },
  },

  {
    name: '14-chip-damage-matters',
    reason: 'Deal damage even when you can\'t KO',
    state: createState({
      myTeam: [
        createMon({
          species: 'Toxapex',
          level: 80,
          revealedMoves: new Set(['scald', 'toxic', 'recover']),
          stats: { hp: 120, atk: 83, def: 172, spa: 73, spd: 142, spe: 55 },
          currentHp: 120,
          maxHp: 120,
        }),
      ],
      opponentTeam: [
        createMon({
          species: 'Tyranitar',
          level: 80,
          revealedMoves: new Set(['stoneedge', 'crunch']),
          stats: { hp: 200, atk: 164, def: 130, spa: 105, spd: 120, spe: 81 },
          currentHp: 200,  // Full HP
          maxHp: 200,
        }),
      ],
    }),
    legalActions: [
      { type: 'move', moveIndex: 1 },  // Scald - chip damage
      { type: 'move', moveIndex: 3 },  // Recover - PASSIVE, don't just heal at full HP
    ],
    expectedAction: { type: 'move', moveIndex: 1 },
  },

  {
    name: '15-recognize-checkmate',
    reason: 'Take the guaranteed win',
    state: createState({
      myTeam: [
        createMon({
          species: 'Dragonite',
          level: 80,
          revealedMoves: new Set(['extremespeed', 'earthquake']),
          stats: { hp: 180, atk: 154, def: 115, spa: 120, spd: 120, spe: 100 },
          currentHp: 180,
          maxHp: 180,
        }),
      ],
      opponentTeam: [
        createMon({
          species: 'Snorlax',
          level: 80,
          revealedMoves: new Set(['bodyslam']),
          stats: { hp: 280, atk: 130, def: 85, spa: 85, spd: 130, spe: 50 },
          currentHp: 10,  // Will die to Extreme Speed
          maxHp: 280,
        }),
      ],
    }),
    legalActions: [
      { type: 'move', moveIndex: 1 },  // Extreme Speed - WINS THE GAME
      { type: 'move', moveIndex: 2 },  // Earthquake - also wins but slower
    ],
    expectedAction: { type: 'move', moveIndex: 1 },  // Priority is safer
  },

  {
    name: '16-status-before-switch',
    reason: 'Burn/paralyze before opponent switches',
    state: createState({
      myTeam: [
        createMon({
          species: 'Rotom-Wash',
          level: 80,
          revealedMoves: new Set(['thunderwave', 'hydropump', 'voltswitch']),
          stats: { hp: 120, atk: 75, def: 127, spa: 125, spd: 127, spe: 106 },
          currentHp: 120,
          maxHp: 120,
        }),
      ],
      opponentTeam: [
        createMon({
          species: 'Landorus',  // Wants to switch out
          level: 80,
          revealedMoves: new Set(['earthquake']),
          stats: { hp: 178, atk: 145, def: 110, spa: 135, spd: 100, spe: 121 },
          currentHp: 178,
          maxHp: 178,
        }),
      ],
    }),
    legalActions: [
      { type: 'move', moveIndex: 1 },  // Thunder Wave - cripple the switch-in
      { type: 'move', moveIndex: 2 },  // Hydro Pump - attack
    ],
    expectedAction: { type: 'move', moveIndex: 1 },  // Status is high value
  },

  {
    name: '17-preserve-check',
    reason: 'Keep your only check to opponent\'s threat alive',
    state: createState({
      myTeam: [
        createMon({
          species: 'Skarmory',  // Only check to opponent's Garchomp
          level: 80,
          revealedMoves: new Set(['bravebird', 'roost', 'spikes']),
          stats: { hp: 140, atk: 100, def: 160, spa: 60, spd: 90, spe: 90 },
          currentHp: 20,  // Very low HP
          maxHp: 140,
        }),
        createMon({
          species: 'Blissey',
          currentHp: 400,
          maxHp: 600,
        }),
      ],
      opponentTeam: [
        createMon({
          species: 'Alakazam',  // Special attacker
          level: 80,
          revealedMoves: new Set(['psyshock', 'focusblast']),
          stats: { hp: 130, atk: 70, def: 65, spa: 155, spd: 115, spe: 140 },
          currentHp: 130,
          maxHp: 130,
        }),
      ],
    }),
    legalActions: [
      { type: 'move', moveIndex: 1 },  // Brave Bird - recoil will kill us
      { type: 'move', moveIndex: 2 },  // Roost - CORRECT, preserve the Garchomp check
      { type: 'switch', switchIndex: 2 },  // Blissey also fine
    ],
    expectedAction: { type: 'move', moveIndex: 2 },
  },

  {
    name: '18-tempo-over-power',
    reason: 'Maintain tempo even if lower damage',
    state: createState({
      myTeam: [
        createMon({
          species: 'Landorus',
          level: 80,
          revealedMoves: new Set(['earthquake', 'uturn', 'stoneedge']),
          stats: { hp: 178, atk: 145, def: 110, spa: 135, spd: 100, spe: 121 },
          currentHp: 100,
          maxHp: 178,
        }),
        createMon({
          species: 'Latios',
          level: 80,
          currentHp: 160,
          maxHp: 160,
        }),
      ],
      opponentTeam: [
        createMon({
          species: 'Tyranitar',  // Resists Earthquake
          level: 80,
          revealedMoves: new Set(['stoneedge', 'crunch']),
          stats: { hp: 200, atk: 164, def: 130, spa: 105, spd: 120, spe: 81 },
          currentHp: 200,
          maxHp: 200,
        }),
      ],
    }),
    legalActions: [
      { type: 'move', moveIndex: 1 },  // Earthquake - resisted
      { type: 'move', moveIndex: 2 },  // U-turn - CORRECT, scout and switch
      { type: 'move', moveIndex: 3 },  // Stone Edge - neutral but risky (accuracy)
    ],
    expectedAction: { type: 'move', moveIndex: 2 },
  },

  {
    name: '19-force-50-50',
    reason: 'Make opponent guess rather than giving free turns',
    state: createState({
      myTeam: [
        createMon({
          species: 'Zapdos',
          level: 80,
          revealedMoves: new Set(['thunderbolt', 'heatwave', 'roost']),
          stats: { hp: 180, atk: 110, def: 105, spa: 145, spd: 110, spe: 120 },
          currentHp: 180,
          maxHp: 180,
        }),
      ],
      opponentTeam: [
        createMon({
          species: 'Swampert',  // Electric immune, Fire weak
          level: 80,
          revealedMoves: new Set(['earthquake']),
          stats: { hp: 200, atk: 130, def: 110, spa: 105, spd: 110, spe: 80 },
          currentHp: 200,
          maxHp: 200,
        }),
      ],
    }),
    legalActions: [
      { type: 'move', moveIndex: 1 },  // Thunderbolt - IMMUNE, opponent stays
      { type: 'move', moveIndex: 2 },  // Heat Wave - forces switch or trades
    ],
    expectedAction: { type: 'move', moveIndex: 2 },
  },

  {
    name: '20-recognize-stall-win',
    reason: 'You\'ve already won via stall, don\'t risk it',
    state: createState({
      myTeam: [
        createMon({
          species: 'Toxapex',
          level: 80,
          revealedMoves: new Set(['toxic', 'recover', 'scald']),
          stats: { hp: 120, atk: 83, def: 172, spa: 73, spd: 142, spe: 55 },
          currentHp: 120,
          maxHp: 120,
        }),
      ],
      opponentTeam: [
        createMon({
          species: 'Snorlax',  // Badly poisoned, will die soon
          level: 80,
          revealedMoves: new Set(['bodyslam']),
          stats: { hp: 280, atk: 130, def: 85, spa: 85, spd: 130, spe: 50 },
          currentHp: 50,  // Low HP and poisoned
          maxHp: 280,
          status: 'tox',  // Toxic
        }),
      ],
    }),
    legalActions: [
      { type: 'move', moveIndex: 1 },  // Toxic - already poisoned
      { type: 'move', moveIndex: 2 },  // Recover - CORRECT, stall out the poison
      { type: 'move', moveIndex: 3 },  // Scald - risky, burn might not happen
    ],
    expectedAction: { type: 'move', moveIndex: 2 },
  },
];

// Export count
export const TOTAL_DIAGNOSTIC_TESTS = expandedDiagnosticTests.length;
