#!/usr/bin/env node

import { SelfPlayHarness } from '../learning/self-play.js';
import { BattleLogger } from '../learning/battle-logger.js';
import { dataLoader } from '../data/data-loader.js';
import { publishDataResult } from '../data/publish.js';

async function main() {
  console.log('=== Pokemon Showdown Bot Benchmark ===\n');
  console.log('Loading data...');
  const { gen9RandomBattle } = await import('../formats/gen9-randombattle.js');
  await dataLoader.load(gen9RandomBattle);

  const logger = new BattleLogger();
  const harness = new SelfPlayHarness(logger);

  const numGames = 50;

  console.log('\n--- Benchmark 1: MCTS vs Random ---');
  const result1 = await harness.runGames({
    numGames,
    bot1Type: 'mcts',
    bot2Type: 'random',
    verbose: false,
  });

  console.log('\n--- Benchmark 2: MCTS vs Max-Damage ---');
  const result2 = await harness.runGames({
    numGames,
    bot1Type: 'mcts',
    bot2Type: 'maxdamage',
    verbose: false,
  });

  console.log('\n--- Benchmark 3: Max-Damage vs Random ---');
  const result3 = await harness.runGames({
    numGames,
    bot1Type: 'maxdamage',
    bot2Type: 'random',
    verbose: false,
  });

  console.log('\n=== Summary ===');
  console.log(`MCTS vs Random: ${(result1.winRate * 100).toFixed(1)}% (${result1.bot1Wins}W-${result1.bot2Wins}L-${result1.ties}T)`);
  console.log(`MCTS vs Max-Damage: ${(result2.winRate * 100).toFixed(1)}% (${result2.bot1Wins}W-${result2.bot2Wins}L-${result2.ties}T)`);
  console.log(`Max-Damage vs Random: ${(result3.winRate * 100).toFixed(1)}% (${result3.bot1Wins}W-${result3.bot2Wins}L-${result3.ties}T)`);

  const passThreshold = 0.65;
  const mctsVsRandom = result1.winRate >= passThreshold;
  const mctsVsMaxDamage = result2.winRate >= passThreshold;

  console.log('\n=== Pass/Fail ===');
  console.log(`MCTS vs Random (>=${passThreshold * 100}%): ${mctsVsRandom ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`MCTS vs Max-Damage (>=${passThreshold * 100}%): ${mctsVsMaxDamage ? '✓ PASS' : '✗ FAIL'}`);

  logger.close();
  const scored = <T extends { lastLog?: string }>(result: T) => {
    const { lastLog: _lastLog, ...rest } = result;
    return rest;
  };
  publishDataResult('logs/benchmark.json', {
    mctsVsRandom: scored(result1),
    mctsVsMaxDamage: scored(result2),
    maxDamageVsRandom: scored(result3),
  });

  if (mctsVsRandom && mctsVsMaxDamage) {
    console.log('\n✓ All benchmarks passed!');
    process.exit(0);
  } else {
    console.log('\n✗ Some benchmarks failed');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
