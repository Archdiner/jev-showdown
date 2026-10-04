import type { GameState, PokemonBelief, RandbatsStats } from '../types/index.js';
import type { AdvisorCandidate } from './types.js';

const EVS = { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 };

function mon(partial: Pick<PokemonBelief, 'species' | 'level'> & Partial<PokemonBelief>): PokemonBelief {
  return {
    possibleSets: new Map(),
    revealedMoves: new Set(),
    boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
    ...partial,
  };
}

/**
 * Garchomp vs Levitate Rotom-Wash.
 * Search ranks Stone Edge first. The calc does not: Dragon Claw is STAB and
 * 100% accurate, Stone Edge is unSTABbed and 80% accurate, Earthquake is immune.
 */
export function garchompRotomFixture(): {
  state: GameState;
  pools: RandbatsStats;
  scored: Array<{ action: AdvisorCandidate['action']; searchScore: number }>;
  candidates: AdvisorCandidate[];
} {
  const state: GameState = {
    turn: 4,
    playerId: 'p1',
    myActive: 0,
    opponentActive: 0,
    myTeraUsed: false,
    opponentTeraUsed: false,
    field: { trickRoom: false, screens: {} },
    hazards: {
      my: { stealthRock: false, spikes: 0, toxicSpikes: 0 },
      opponent: { stealthRock: true, spikes: 0, toxicSpikes: 0 },
    },
    myTeam: [
      mon({
        species: 'Garchomp',
        level: 80,
        currentHp: 100,
        maxHp: 100,
        revealedAbility: 'Rough Skin',
        revealedItem: 'Life Orb',
        moves: ['Dragon Claw', 'Stone Edge', 'Earthquake', 'Swords Dance'],
        possibleSets: new Map([['Physical Attacker', 1]]),
      }),
      mon({
        species: 'Skarmory',
        level: 80,
        currentHp: 70,
        maxHp: 100,
        revealedAbility: 'Sturdy',
        revealedItem: 'Leftovers',
      }),
    ],
    opponentTeam: [
      mon({
        species: 'Rotom-Wash',
        level: 84,
        currentHp: 100,
        maxHp: 100,
        revealedAbility: 'Levitate',
        revealedItem: 'Leftovers',
        possibleSets: new Map([['Bulky Pivot', 1]]),
      }),
    ],
  };

  const pools: RandbatsStats = {
    Garchomp: {
      level: 80,
      abilities: { 'Rough Skin': 1 },
      items: { 'Life Orb': 1 },
      roles: {
        'Physical Attacker': {
          weight: 1,
          nature: 'Adamant',
          evs: EVS,
          moves: { 'Dragon Claw': 1, 'Stone Edge': 1, Earthquake: 1, 'Swords Dance': 1 },
          items: { 'Life Orb': 1 },
        },
      },
    },
    'Rotom-Wash': {
      level: 84,
      abilities: { Levitate: 1 },
      items: { Leftovers: 1 },
      roles: {
        'Bulky Pivot': {
          weight: 1,
          nature: 'Bold',
          evs: EVS,
          moves: { 'Hydro Pump': 1, 'Volt Switch': 0.9, 'Will-O-Wisp': 0.8, 'Pain Split': 0.5 },
          items: { Leftovers: 1 },
        },
      },
    },
    Skarmory: {
      level: 80,
      abilities: { Sturdy: 1 },
      items: { Leftovers: 1 },
      roles: {
        Wall: { weight: 1, nature: 'Impish', evs: EVS, moves: { 'Brave Bird': 1, Roost: 1 }, items: { Leftovers: 1 } },
      },
    },
  };

  const scored = [
    { action: { type: 'move' as const, moveIndex: 2 }, searchScore: 10 },
    { action: { type: 'move' as const, moveIndex: 1 }, searchScore: 9.5 },
    { action: { type: 'move' as const, moveIndex: 3 }, searchScore: 9.8 },
    { action: { type: 'move' as const, moveIndex: 4 }, searchScore: 8 },
  ];

  const candidates: AdvisorCandidate[] = [
    { id: 'stone', label: 'Stone Edge', action: scored[0].action, searchScore: 10 },
    { id: 'claw', label: 'Dragon Claw', action: scored[1].action, searchScore: 9.5 },
    { id: 'quake', label: 'Earthquake', action: scored[2].action, searchScore: 9.8 },
    { id: 'dance', label: 'Swords Dance', action: scored[3].action, searchScore: 8 },
  ];

  return { state, pools, scored, candidates };
}
