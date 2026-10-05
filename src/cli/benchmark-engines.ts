#!/usr/bin/env node

/**
 * Benchmark Simple1Ply and RobustSearch engines
 * Goal: ≥90% vs random, ≥70% vs max-damage
 */

import { SelfPlayHarness } from '../learning/self-play.js';
import { BattleLogger } from '../learning/battle-logger.js';
import { dataLoader } from '../data/data-loader.js';
import { publishDataResult } from '../data/publish.js';

async function main() {
  console.log('=== Engine Benchmark ===\n');
  console.log('Loading data...');
  const { gen9RandomBattle } = await import('../formats/gen9-randombattle.js');
  await dataLoader.load(gen9RandomBattle);
  console.log('Data loaded.\n');

  const logger = new BattleLogger();
  const harness = new SelfPlayHarness(logger);

  const numGames = 50;  // Start with 50, can increase to 200 later

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

  console.log('\n--- Max-Damage vs Random (baseline) ---');
  const maxDamageRandom = await harness.runGames({
    numGames,
    bot1Type: 'maxdamage',
    bot2Type: 'random',
    verbose: false,
  });

  // Print summary table
  console.log('\n=== Benchmark Results ===\n');
  console.log('Engine        | vs Random | vs MaxDmg | Fallback');
  console.log('--------------|-----------|-----------|----------');
  
  const s1rWinRate = `${(simple1Random.winRate * 100).toFixed(1)}%`.padEnd(9);
  const s1mWinRate = `${(simple1MaxDamage.winRate * 100).toFixed(1)}%`.padEnd(9);
  console.log(`Simple1Ply    | ${s1rWinRate} | ${s1mWinRate} | N/A`);
  
  const rrWinRate = `${(robustRandom.winRate * 100).toFixed(1)}%`.padEnd(9);
  const rmWinRate = `${(robustMaxDamage.winRate * 100).toFixed(1)}%`.padEnd(9);
  const fallbackRate = robustRandom.fallbackStats ? `${(robustRandom.fallbackStats.fallbackRate * 100).toFixed(1)}%` : 'N/A';
  console.log(`RobustSearch  | ${rrWinRate} | ${rmWinRate} | ${fallbackRate}`);
  
  const mdrWinRate = `${(maxDamageRandom.winRate * 100).toFixed(1)}%`.padEnd(9);
  console.log(`Max-Damage    | ${mdrWinRate} | N/A       | N/A`);

  console.log('\n=== Target Thresholds ===');
  console.log('vs Random: ≥90%');
  console.log('vs Max-Damage: ≥70%\n');

  console.log('=== Pass/Fail ===');
  const s1Pass = simple1Random.winRate >= 0.90 && simple1MaxDamage.winRate >= 0.70;
  const rPass = robustRandom.winRate >= 0.90 && robustMaxDamage.winRate >= 0.70;
  
  console.log(`Simple1Ply: ${s1Pass ? '✓ PASS' : '✗ FAIL'} (${(simple1Random.winRate * 100).toFixed(1)}% vs random, ${(simple1MaxDamage.winRate * 100).toFixed(1)}% vs max-damage)`);
  console.log(`RobustSearch: ${rPass ? '✓ PASS' : '✗ FAIL'} (${(robustRandom.winRate * 100).toFixed(1)}% vs random, ${(robustMaxDamage.winRate * 100).toFixed(1)}% vs max-damage)`);

  logger.close();
  const scored = <T extends { lastLog?: string }>(result: T) => {
    const { lastLog: _lastLog, ...rest } = result;
    return rest;
  };
  publishDataResult('logs/benchmark-engines.json', {
    simple1Random: scored(simple1Random),
    simple1MaxDamage: scored(simple1MaxDamage),
    robustRandom: scored(robustRandom),
    robustMaxDamage: scored(robustMaxDamage),
    maxDamageRandom: scored(maxDamageRandom),
  });
  process.exit(s1Pass || rPass ? 0 : 1);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
