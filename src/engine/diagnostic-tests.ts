#!/usr/bin/env node

/**
 * Diagnostic test suite for search engine.
 * Hand-crafted positions with obvious best moves.
 */

import { RobustSearch } from './robust-search.js';
import { Evaluator } from './evaluator.js';
import { gen9RandomBattle } from '../formats/gen9-randombattle.js';
import { GameState, Action, PokemonBelief } from '../types/index.js';
import { dataLoader } from '../data/data-loader.js';

interface TestCase {
  name: string;
  state: GameState;
  legalActions: Action[];
  expectedAction: Action;
  reason: string;
}

function createBasicState(overrides: Partial<GameState> = {}): GameState {
  return {
    myTeam: [],
    opponentTeam: [],
    myActive: 0,
    opponentActive: 0,
    turn: 1,
    myTeraUsed: false,
    opponentTeraUsed: false,
    field: {
      trickRoom: false,
      screens: {},
    },
    hazards: {
      my: { stealthRock: false, spikes: 0, toxicSpikes: 0 },
      opponent: { stealthRock: false, spikes: 0, toxicSpikes: 0 },
    },
    playerId: 'p1',
    ...overrides,
  };
}

const testCases: TestCase[] = [
  {
    name: 'Test 1: 4x super-effective KO available - should attack',
    state: createBasicState({
      myTeam: [
        {
          species: 'Swampert',
          level: 80,
          possibleSets: new Map(),
          revealedMoves: new Set(['earthquake', 'surf', 'icebeam', 'stealthrock']),
          stats: { hp: 200, atk: 150, def: 120, spa: 100, spd: 120, spe: 80 },
          currentHp: 200,
          maxHp: 200,
        },
      ],
      opponentTeam: [
        {
          species: 'Charizard',  // 4x weak to Rock, but we have Earthquake for ground
          level: 80,
          possibleSets: new Map(),
          revealedMoves: new Set(['flamethrower', 'airslash']),
          stats: { hp: 156, atk: 100, def: 100, spa: 130, spd: 100, spe: 120 },
          currentHp: 50,  // Low HP, easy KO
          maxHp: 156,
        },
      ],
    }),
    legalActions: [
      { type: 'move', moveIndex: 1 },  // Earthquake
      { type: 'move', moveIndex: 2 },  // Surf
      { type: 'switch', switchIndex: 2 },
    ],
    expectedAction: { type: 'move', moveIndex: 1 },  // Earthquake for the KO
    reason: 'Low HP opponent, super-effective move available',
  },

  {
    name: 'Test 2: Don\'t switch into a KO - stay in',
    state: createBasicState({
      myTeam: [
        {
          species: 'Pikachu',
          level: 80,
          possibleSets: new Map(),
          revealedMoves: new Set(['thunderbolt', 'voltswitch', 'surf', 'grassknot']),
          stats: { hp: 120, atk: 70, def: 60, spa: 100, spd: 80, spe: 110 },
          currentHp: 120,
          maxHp: 120,
        },
        {
          species: 'Gyarados',  // Water/Flying, 4x weak to Electric
          level: 80,
          possibleSets: new Map(),
          revealedMoves: new Set(['waterfall', 'earthquake']),
          stats: { hp: 180, atk: 145, def: 100, spa: 80, spd: 120, spe: 100 },
          currentHp: 180,
          maxHp: 180,
        },
      ],
      opponentTeam: [
        {
          species: 'Jolteon',  // Electric, will KO Gyarados
          level: 80,
          possibleSets: new Map(),
          revealedMoves: new Set(['thunderbolt', 'voltswitch']),
          stats: { hp: 130, atk: 80, def: 80, spa: 130, spd: 110, spe: 150 },
          currentHp: 130,
          maxHp: 130,
        },
      ],
    }),
    legalActions: [
      { type: 'move', moveIndex: 1 },  // Thunderbolt
      { type: 'move', moveIndex: 2 },  // Volt Switch
      { type: 'switch', switchIndex: 2 },  // Switch to Gyarados (BAD!)
    ],
    expectedAction: { type: 'move', moveIndex: 1 },  // Stay in and attack
    reason: 'Don\'t switch into 4x weakness',
  },

  {
    name: 'Test 3: Stay in vs walled opponent',
    state: createBasicState({
      myTeam: [
        {
          species: 'Blissey',  // Special wall
          level: 80,
          possibleSets: new Map(),
          revealedMoves: new Set(['seismictoss', 'softboiled', 'toxic', 'stealthrock']),
          stats: { hp: 600, atk: 50, def: 50, spa: 90, spd: 150, spe: 70 },
          currentHp: 600,
          maxHp: 600,
        },
      ],
      opponentTeam: [
        {
          species: 'Alakazam',  // Special attacker, walled by Blissey
          level: 80,
          possibleSets: new Map(),
          revealedMoves: new Set(['psyshock', 'focusblast']),
          stats: { hp: 130, atk: 70, def: 65, spa: 155, spd: 110, spe: 140 },
          currentHp: 130,
          maxHp: 130,
        },
      ],
    }),
    legalActions: [
      { type: 'move', moveIndex: 1 },  // Seismic Toss
      { type: 'move', moveIndex: 3 },  // Toxic
      { type: 'switch', switchIndex: 2 },
    ],
    expectedAction: { type: 'move', moveIndex: 1 },  // Stay in, we wall them
    reason: 'Blissey walls special attackers, no reason to switch',
  },

  {
    name: 'Test 4: Perspective test as P2 - take the KO',
    state: createBasicState({
      playerId: 'p2',  // We're player 2
      myTeam: [
        {
          species: 'Machamp',
          level: 80,
          possibleSets: new Map(),
          revealedMoves: new Set(['closecombat', 'stoneedge', 'bulletpunch', 'earthquake']),
          stats: { hp: 180, atk: 150, def: 100, spa: 80, spd: 100, spe: 70 },
          currentHp: 180,
          maxHp: 180,
        },
      ],
      opponentTeam: [
        {
          species: 'Snorlax',
          level: 80,
          possibleSets: new Map(),
          revealedMoves: new Set(['bodyslam', 'crunch']),
          stats: { hp: 280, atk: 130, def: 85, spa: 85, spd: 130, spe: 50 },
          currentHp: 30,  // Very low HP
          maxHp: 280,
        },
      ],
    }),
    legalActions: [
      { type: 'move', moveIndex: 1 },  // Close Combat - KO
      { type: 'move', moveIndex: 2 },  // Stone Edge
      { type: 'switch', switchIndex: 2 },
    ],
    expectedAction: { type: 'move', moveIndex: 1 },  // Take the KO
    reason: 'As P2, should still recognize KO opportunity',
  },
];

async function runTests() {
  console.log('=== Diagnostic Test Suite ===\n');
  
  await dataLoader.load(gen9RandomBattle);
  
  const config = {
    searchTimeMs: 5000,
    sampledWorlds: 3,
    maxDepth: 3,
    searchIterations: 1000,
    explorationConstant: 1.41,
    useTeraHeuristic: false,
    useLLMPrior: false,
  };
  
  const evaluator = new Evaluator();
  const search = new RobustSearch(config, evaluator, gen9RandomBattle);
  
  let passed = 0;
  let failed = 0;
  
  for (const test of testCases) {
    console.log(`Running: ${test.name}`);
    console.log(`  Reason: ${test.reason}`);
    console.log(`  Player: ${test.state.playerId || 'p1'}`);
    
    try {
      const startTime = Date.now();
      const action = await search.search(test.state, test.legalActions);
      const timeMs = Date.now() - startTime;
      
      const match = JSON.stringify(action) === JSON.stringify(test.expectedAction);
      
      if (match) {
        console.log(`  ✓ PASSED (${timeMs}ms)`);
        console.log(`  Selected: ${JSON.stringify(action)}\n`);
        passed++;
      } else {
        console.log(`  ✗ FAILED (${timeMs}ms)`);
        console.log(`  Expected: ${JSON.stringify(test.expectedAction)}`);
        console.log(`  Got:      ${JSON.stringify(action)}\n`);
        failed++;
      }
    } catch (e) {
      console.log(`  ✗ ERROR: ${e}\n`);
      failed++;
    }
  }
  
  console.log('=== Summary ===');
  console.log(`Passed: ${passed}/${testCases.length}`);
  console.log(`Failed: ${failed}/${testCases.length}`);
  
  const fallbackStats = search.getFallbackStats();
  console.log(`\nFallback rate: ${(fallbackStats.fallbackRate * 100).toFixed(2)}%`);
  console.log(`  (${fallbackStats.fallbackCount}/${fallbackStats.totalCalls} calls)`);
  
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => {
  console.error('Test suite error:', e);
  process.exit(1);
});
