#!/usr/bin/env node

import { SelfPlayHarness } from '../learning/self-play.js';
import { BattleLogger } from '../learning/battle-logger.js';
import { dataLoader } from '../data/data-loader.js';

async function main() {
  const args = process.argv.slice(2);
  
  const numGames = parseInt(args[0]) || 100;
  const bot1Type = (args[1] || 'mcts') as 'mcts' | 'random' | 'maxdamage';
  const bot2Type = (args[2] || 'random') as 'mcts' | 'random' | 'maxdamage';
  const verbose = args.includes('--verbose');

  console.log('Loading data...');
  const { gen9RandomBattle } = await import('../formats/gen9-randombattle.js');
  await dataLoader.load(gen9RandomBattle);

  const logger = new BattleLogger();
  const harness = new SelfPlayHarness(logger);

  const result = await harness.runGames({
    numGames,
    bot1Type,
    bot2Type,
    verbose,
  });

  logger.close();

  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
