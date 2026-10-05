#!/usr/bin/env node

/**
 * Quick benchmark with fewer games for faster iteration
 */

import { SelfPlayHarness } from '../learning/self-play.js';
import { BattleLogger } from '../learning/battle-logger.js';
import { dataLoader } from '../data/data-loader.js';

async function main() {
  console.log('=== Quick Engine Benchmark (20 games each) ===\n');
  console.log('Loading data...');
  const { gen9RandomBattle } = await import('../formats/gen9-randombattle.js');
  await dataLoader.load(gen9RandomBattle);
  console.log('Data loaded.\n');

  const logger = new BattleLogger();
  const harness = new SelfPlayHarness(logger);

  const numGames = 20;  // Quick test

  console.log('=== Testing Simple1Ply ===\n');

  console.log('--- Simple1Ply vs Random ---');
  const simple1Random = await harness.runGames({
    numGames,
    bot1Type: 'simple1ply',
    bot2Type: 'random',
    verbose: false,
  });

  console.log('\n--- Simple1Ply vs Max-Damage ---');
  const simple1MaxDamage = await harness.runGames({
    numGames,
    bot1Type: 'simple1ply',
    bot2Type: 'maxdamage',
    verbose: false,
  });

  console.log('\n\n=== Testing RobustSearch ===\n');

  console.log('--- RobustSearch vs Random ---');
  const robustRandom = await harness.runGames({
    numGames,
    bot1Type: 'robust',
    bot2Type: 'random',
    verbose: false,
  });

  console.log('\n--- RobustSearch vs Max-Damage ---');
  const robustMaxDamage = await harness.runGames({
    numGames,
    bot1Type: 'robust',
    bot2Type: 'maxdamage',
    verbose: false,
  });

  // Print summary
  console.log('\n=== Quick Benchmark Results (20 games each) ===\n');
  console.log('Engine        | vs Random | vs MaxDmg');
  console.log('--------------|-----------|----------');
  
  const s1rWinRate = `${(simple1Random.winRate * 100).toFixed(1)}%`.padEnd(9);
  const s1mWinRate = `${(simple1MaxDamage.winRate * 100).toFixed(1)}%`.padEnd(9);
  console.log(`Simple1Ply    | ${s1rWinRate} | ${s1mWinRate}`);
  
  const rrWinRate = `${(robustRandom.winRate * 100).toFixed(1)}%`.padEnd(9);
  const rmWinRate = `${(robustMaxDamage.winRate * 100).toFixed(1)}%`.padEnd(9);
  console.log(`RobustSearch  | ${rrWinRate} | ${rmWinRate}`);

  console.log('\n=== Comparison ===');
  const diff = simple1Random.winRate - robustRandom.winRate;
  if (Math.abs(diff) < 0.05) {
    console.log('Similar performance (within 5%)');
  } else if (diff > 0) {
    console.log(`Simple1Ply is ${(diff * 100).toFixed(1)}% better vs random`);
  } else {
    console.log(`RobustSearch is ${(-diff * 100).toFixed(1)}% better vs random`);
  }

  logger.close();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
