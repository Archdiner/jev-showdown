import { Bot } from './src/bot/bot.js';
import { BattleLogger } from './src/learning/battle-logger.js';
import { dataLoader } from './src/data/data-loader.js';
import { GameState, BotConfig, Action } from './src/types/index.js';

async function test() {
  await dataLoader.load();

  const config: BotConfig = {
    searchTimeMs: 50,
    searchIterations: 20,
    explorationConstant: 1.4,
    sampledWorlds: 1,
    useTeraHeuristic: true,
    useLLMPrior: false,
  };

  const logger = new BattleLogger();
  const bot = new Bot(config, logger);

  const state: GameState = {
    myTeam: [
      {
        species: 'Pikachu',
        level: 88,
        possibleSets: new Map(),
        revealedMoves: new Set(['Thunderbolt', 'Volt Switch']),
      },
    ],
    opponentTeam: [
      {
        species: 'Charizard',
        level: 80,
        possibleSets: new Map(),
        revealedMoves: new Set(),
      },
    ],
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
    { type: 'move', moveIndex: 1 },
    { type: 'move', moveIndex: 2 },
  ];

  console.log('Testing bot.selectAction...');
  const start = Date.now();
  const action = bot.selectAction(state, actions);
  const elapsed = Date.now() - start;

  console.log(`Selected action: ${JSON.stringify(action)}`);
  console.log(`Time: ${elapsed}ms`);

  logger.close();
}

test().catch(console.error);
