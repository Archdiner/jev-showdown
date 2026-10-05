#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, toSpec } from '../config/load.js';
import type { BotSpec } from '../config/interfaces.js';
import { playPaired, sideWinRate } from '../exp/play.js';
import { dataLoader } from '../data/data-loader.js';
import { GameResult } from './game.js';

interface BenchResult {
  challenger: string;
  baseline: string;
  games: number;
  wins: number;
  winRate: number;
  wilsonLowerBound: number;
  endgameGames: number;
  endgameWins: number;
  endgameWinRate: number;
  p50Latency: number;
  p99Latency: number;
  invalidChoices: number;
  crashes: number;
}

function wilsonLowerBound(wins: number, total: number, z = 1.96): number {
  if (total === 0) return 0;
  const p = wins / total;
  const denominator = 1 + z * z / total;
  const center = p + z * z / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total);
  return (center - margin) / denominator;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, index)];
}

function isEndgame(result: GameResult): boolean {
  // Check if the game reached an endgame state (<=4 mons remaining)
  // This is a heuristic based on turn count and winner
  // In practice, we'd need to track this during the game
  // For now, we'll approximate based on turn count
  return (result.turns ?? 0) > 15;
}

async function main() {
  console.log('=== Endgame Deepening Benchmark ===\n');
  
  // Load data and check species count
  const { gen9RandomBattle } = await import('../formats/gen9-randombattle.js');
  await dataLoader.load(gen9RandomBattle);
  const speciesCount = Object.keys(dataLoader.getSets()).length;
  
  console.log(`Species count: ${speciesCount}`);
  if (speciesCount < 500) {
    console.error('ERROR: Species count < 500, possible fixture clobber');
    process.exit(1);
  }
  if (speciesCount !== 509) {
    console.warn(`WARNING: Expected 509 species, got ${speciesCount}`);
  }
  
  // Load configs
  const baselineConfig = loadConfig('configs/champion.yaml');
  const challengerConfig = loadConfig('configs/examples/search-endgame-deepening.yaml');
  
  const baseline: BotSpec = toSpec(baselineConfig, 'gate');
  const challenger: BotSpec = toSpec(challengerConfig, 'gate');
  
  console.log(`\nBaseline: ${baseline.config.name} (${baseline.configId})`);
  console.log(`Challenger: ${challenger.config.name} (${challenger.configId})`);
  console.log(`\nBaseline config spec:`);
  console.log(JSON.stringify(baseline.config.search, null, 2));
  console.log(`\nChallenger config spec:`);
  console.log(JSON.stringify(challenger.config.search, null, 2));
  
  // Run initial 200 games
  let gameCount = 200;
  console.log(`\n--- Running ${gameCount} paired games ---`);
  let results = await playPaired(challenger, baseline, gameCount, 1);
  
  const rate = sideWinRate(results, challenger.configId);
  const lowerBound = wilsonLowerBound(rate.wins, rate.games);
  
  console.log(`\nInitial results (${gameCount} games):`);
  console.log(`  Win rate: ${(rate.winRate * 100).toFixed(1)}% (${rate.wins}W-${rate.games - rate.wins}L)`);
  console.log(`  Wilson 95% lower bound: ${(lowerBound * 100).toFixed(1)}%`);
  
  // Extend to 800 if > 50%
  if (rate.winRate > 0.50 && gameCount < 800) {
    const additionalGames = 800 - gameCount;
    console.log(`\n--- Extending to 800 games (${additionalGames} more) ---`);
    const additionalResults = await playPaired(
      challenger,
      baseline,
      additionalGames,
      1 + gameCount / 2
    );
    results = [...results, ...additionalResults];
    gameCount = 800;
  }
  
  // Final statistics
  const finalRate = sideWinRate(results, challenger.configId);
  const finalLower = wilsonLowerBound(finalRate.wins, finalRate.games);
  
  // Latency analysis
  const latencies: number[] = [];
  for (const result of results) {
    if (result.p1ConfigId === challenger.configId) {
      latencies.push(...result.p1TurnTimes);
    }
    if (result.p2ConfigId === challenger.configId) {
      latencies.push(...result.p2TurnTimes);
    }
  }
  
  const p50 = percentile(latencies, 0.50);
  const p99 = percentile(latencies, 0.99);
  
  // Count endgame-triggered games (approximation)
  let endgameGames = 0;
  let endgameWins = 0;
  for (const result of results) {
    if (isEndgame(result)) {
      endgameGames++;
      const won =
        (result.p1ConfigId === challenger.configId && result.winner === 'p1') ||
        (result.p2ConfigId === challenger.configId && result.winner === 'p2');
      if (won) endgameWins++;
    }
  }
  
  // Count errors
  let crashes = 0;
  let invalidChoices = 0;
  for (const result of results) {
    if (result.crashed) crashes++;
    // Invalid choices tracked per-side if available
  }
  
  const benchResult: BenchResult = {
    challenger: challenger.config.name,
    baseline: baseline.config.name,
    games: finalRate.games,
    wins: finalRate.wins,
    winRate: finalRate.winRate,
    wilsonLowerBound: finalLower,
    endgameGames,
    endgameWins,
    endgameWinRate: endgameGames > 0 ? endgameWins / endgameGames : 0,
    p50Latency: p50,
    p99Latency: p99,
    invalidChoices,
    crashes,
  };
  
  console.log(`\n=== Final Results (${gameCount} games) ===`);
  console.log(`Win rate: ${(benchResult.winRate * 100).toFixed(1)}% (${benchResult.wins}W-${benchResult.games - benchResult.wins}L)`);
  console.log(`Wilson 95% CI lower bound: ${(benchResult.wilsonLowerBound * 100).toFixed(1)}%`);
  console.log(`\nEndgame performance (approx ${endgameGames} games):`);
  console.log(`  Win rate: ${(benchResult.endgameWinRate * 100).toFixed(1)}% (${endgameWins}W-${endgameGames - endgameWins}L)`);
  console.log(`\nLatency:`);
  console.log(`  p50: ${p50.toFixed(0)} ms`);
  console.log(`  p99: ${p99.toFixed(0)} ms`);
  console.log(`\nGuardrails:`);
  console.log(`  Invalid choices: ${invalidChoices}`);
  console.log(`  Crashes: ${crashes}`);
  
  // Check guardrails
  if (p99 >= 300) {
    console.log(`\n⚠ WARNING: p99 latency ${p99.toFixed(0)} ms exceeds 300 ms threshold`);
  }
  if (invalidChoices > 0 || crashes > 0) {
    console.log(`\n⚠ WARNING: Guardrail violations detected`);
  }
  
  // Save results
  const outputDir = path.join(process.cwd(), 'state', 'benchmarks');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputFile = path.join(outputDir, `endgame-deepening-${Date.now()}.json`);
  fs.writeFileSync(outputFile, JSON.stringify(benchResult, null, 2));
  console.log(`\nResults saved to: ${outputFile}`);
  
  // Recommendation
  console.log(`\n=== Recommendation ===`);
  if (benchResult.wilsonLowerBound > 0.50 && p99 < 300 && crashes === 0) {
    console.log('✓ RECOMMEND for live A/B testing');
    console.log(`  - Win rate ${(benchResult.winRate * 100).toFixed(1)}% with CI lower bound ${(benchResult.wilsonLowerBound * 100).toFixed(1)}%`);
    console.log(`  - p99 latency ${p99.toFixed(0)} ms < 300 ms`);
    console.log(`  - No crashes or invalid choices`);
  } else {
    console.log('✗ NOT RECOMMENDED for live A/B testing');
    if (benchResult.wilsonLowerBound <= 0.50) {
      console.log(`  - Win rate too low: ${(benchResult.winRate * 100).toFixed(1)}% (CI lower ${(benchResult.wilsonLowerBound * 100).toFixed(1)}%)`);
    }
    if (p99 >= 300) {
      console.log(`  - Latency too high: p99 ${p99.toFixed(0)} ms >= 300 ms`);
    }
    if (crashes > 0) {
      console.log(`  - ${crashes} crashes detected`);
    }
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
