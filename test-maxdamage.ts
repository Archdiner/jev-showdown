import { MaxDamageBot } from './src/baselines/max-damage-bot.js';
import { GameState, Action } from './src/types/index.js';
import { dataLoader } from './src/data/data-loader.js';

async function test() {
  await dataLoader.load();

  const bot = new MaxDamageBot();

  const state: GameState = {
    myTeam: [{
      species: 'Pikachu',
      level: 88,
      possibleSets: new Map(),
      revealedMoves: new Set(['Thunderbolt', 'Surf', 'Volt Switch', 'Thunder']),
      stats: { hp: 200, atk: 100, def: 80, spa: 150, spd: 90, spe: 180 },
    }],
    opponentTeam: [{
      species: 'Gyarados',
      level: 80,
      possibleSets: new Map(),
      revealedMoves: new Set(),
      stats: { hp: 300, atk: 180, def: 120, spa: 80, spd: 130, spe: 110 },
    }],
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

  const actions: Action[] = [
    { type: 'move', moveIndex: 1 }, // Thunderbolt
    { type: 'move', moveIndex: 2 }, // Surf
    { type: 'move', moveIndex: 3 }, // Volt Switch
    { type: 'move', moveIndex: 4 }, // Thunder
  ];

  console.log('Testing MaxDamageBot against Gyarados (Water/Flying):');
  console.log('Available moves: Thunderbolt, Surf, Volt Switch, Thunder');
  console.log('Expected: Should pick Thunderbolt or Thunder (4x super effective)');
  
  const action = bot.selectAction(state, actions);
  console.log(`\nChosen action: ${JSON.stringify(action)}`);
  
  if (action.type === 'move') {
    const moves = ['Thunderbolt', 'Surf', 'Volt Switch', 'Thunder'];
    console.log(`Move selected: ${moves[action.moveIndex - 1]}`);
  }
}

test().catch(console.error);
