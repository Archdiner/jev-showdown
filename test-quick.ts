#!/usr/bin/env node

import { loadConfig, toSpec } from './src/config/load.js';
import { playPaired, sideWinRate } from './src/exp/play.js';
import { dataLoader } from './src/data/data-loader.js';

async function main() {
  const { gen9RandomBattle } = await import('./src/formats/gen9-randombattle.js');
  await dataLoader.load(gen9RandomBattle);
  
  const baseline = toSpec(loadConfig('configs/champion.yaml'), 'gate');
  const challenger = toSpec(loadConfig('configs/examples/search-endgame-deepening.yaml'), 'gate');
  
  console.log('Testing with 20 games...');
  const results = await playPaired(challenger, baseline, 20, 1);
  
  const rate = sideWinRate(results, challenger.configId);
  const latencies: number[] = [];
  for (const result of results) {
    if (result.p1ConfigId === challenger.configId) latencies.push(...result.p1TurnTimes);
    if (result.p2ConfigId === challenger.configId) latencies.push(...result.p2TurnTimes);
  }
  
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
  const p99 = sorted[Math.ceil(sorted.length * 0.99) - 1] ?? 0;
  
  console.log(`Win rate: ${(rate.winRate * 100).toFixed(1)}% (${rate.wins}/${rate.games})`);
  console.log(`p50: ${p50.toFixed(0)}ms, p99: ${p99.toFixed(0)}ms`);
}

main().catch(console.error);
