#!/usr/bin/env node

/**
 * Evaluation script for belief updater.
 * Runs 800 seat-swapped paired hidden-info games comparing configs.
 */

import { Battle, PRNG } from '@pkmn/sim';
import { dataLoader } from '../data/data-loader.js';
import { loadConfig } from '../config/load.js';
import { buildBot } from '../config/bot.js';
import { legalChoices, playChoices, snapshot, startRandomBattle, teamsForSeed, type SideId } from '../engine/exact/battle-utils.js';
import { informationMode, ladderDecisionBattle } from '../client/hidden-info.js';
import { gen9RandomBattle } from '../formats/gen9-randombattle.js';

interface GameResult {
  seed: number;
  winner: 'p1' | 'p2' | 'tie';
  turns: number;
  p1Latency: { p50: number; p99: number };
  p2Latency: { p50: number; p99: number };
  p1Invalid: number;
  p2Invalid: number;
  p1Crashes: number;
  p2Crashes: number;
}

interface EvalResult {
  config1: string;
  config2: string;
  games: number;
  config1Wins: number;
  config2Wins: number;
  ties: number;
  winRate: number;
  wilsonLower: number;
  wilsonUpper: number;
  avgTurns: number;
  p1Latency: { p50: number; p99: number };
  p2Latency: { p50: number; p99: number };
  totalInvalid: number;
  totalCrashes: number;
}

async function playGame(
  seed: number,
  config1Path: string,
  config2Path: string,
  swapped: boolean
): Promise<GameResult> {
  const teams = teamsForSeed(seed);
  const battle = startRandomBattle(teams.p1, teams.p2, seed);
  
  // Handle team preview
  if (battle.requestState === 'teampreview') {
    battle.choose('p1', 'default');
    battle.choose('p2', 'default');
  }

  const bot1 = buildBot(config1Path, { name: 'gate', network: 'none', llm: { allowed: false, costCapUsd: 0 }, timeLimitMs: 10000, logSink: 'memory' });
  const bot2 = buildBot(config2Path, { name: 'gate', network: 'none', llm: { allowed: false, costCapUsd: 0 }, timeLimitMs: 10000, logSink: 'memory' });
  
  const latencies: { p1: number[]; p2: number[] } = { p1: [], p2: [] };
  let invalid = { p1: 0, p2: 0 };
  let crashes = { p1: 0, p2: 0 };

  while (!battle.ended) {
    for (const sideId of ['p1', 'p2'] as SideId[]) {
      const side = battle.getSide(sideId);
      if (!side.activeRequest || side.activeRequest.wait) continue;

      // Build hidden-info decision battle
      const decisionBattle = ladderDecisionBattle(battle, sideId, { quickWins: true });
      if (!decisionBattle) continue;

      const bot = swapped
        ? (sideId === 'p1' ? bot2 : bot1)
        : (sideId === 'p1' ? bot1 : bot2);
      
      const legal = legalChoices(decisionBattle, 'p1');
      if (legal.length === 0) continue;

      let choice = legal[0];
      let latency = 0;
      
      try {
        const start = Date.now();
        const decision = await bot.decide({
          battle: decisionBattle,
          side: 'p1',
        });
        latency = Date.now() - start;
        choice = decision.choice;

        // Verify the choice is valid in the actual battle
        const actualLegal = legalChoices(battle, sideId);
        if (!actualLegal.includes(choice)) {
          // Map the decision battle choice to actual battle choice if possible
          // Decision battle uses p1 indexing, actual battle uses the side's indexing
          if (!legal.includes(decision.choice)) {
            invalid[sideId]++;
            choice = actualLegal[0];
          } else {
            choice = decision.choice;
          }
        }
      } catch (err) {
        crashes[sideId]++;
        console.error(`Crash for ${sideId} on seed ${seed}:`, err);
        choice = legalChoices(battle, sideId)[0] || 'pass';
      }

      latencies[sideId].push(latency);
      battle.choose(sideId, choice);
    }
  }

  const winner = battle.winner === 'Player 1' ? 'p1' : battle.winner === 'Player 2' ? 'p2' : 'tie';
  
  return {
    seed,
    winner: swapped ? (winner === 'p1' ? 'p2' : winner === 'p2' ? 'p1' : 'tie') : winner,
    turns: battle.turn,
    p1Latency: calcLatencyStats(latencies.p1),
    p2Latency: calcLatencyStats(latencies.p2),
    p1Invalid: invalid.p1,
    p2Invalid: invalid.p2,
    p1Crashes: crashes.p1,
    p2Crashes: crashes.p2,
  };
}

function calcLatencyStats(latencies: number[]): { p50: number; p99: number } {
  if (latencies.length === 0) return { p50: 0, p99: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  return { p50, p99 };
}

function wilsonScore(wins: number, total: number, z: number = 1.96): { lower: number; upper: number } {
  if (total === 0) return { lower: 0, upper: 0 };
  const p = wins / total;
  const n = total;
  const denominator = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n) / denominator;
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

async function runEvaluation(
  config1Path: string,
  config2Path: string,
  games: number,
  startSeed: number = 1
): Promise<EvalResult> {
  console.log(`Running ${games} paired games: ${config1Path} vs ${config2Path}`);
  console.log(`Seat-swapping enabled for parity`);

  const results: GameResult[] = [];
  
  for (let i = 0; i < games / 2; i++) {
    const seed = startSeed + i;
    if (i % 50 === 0) {
      console.log(`Progress: ${i * 2}/${games} games...`);
    }

    // Play game with normal seating
    const result1 = await playGame(seed, config1Path, config2Path, false);
    results.push(result1);

    // Play game with swapped seating
    const result2 = await playGame(seed, config1Path, config2Path, true);
    results.push(result2);
  }

  const config1Wins = results.filter(r => r.winner === 'p1').length;
  const config2Wins = results.filter(r => r.winner === 'p2').length;
  const ties = results.filter(r => r.winner === 'tie').length;
  const avgTurns = results.reduce((sum, r) => sum + r.turns, 0) / results.length;

  const allP1Latencies = results.flatMap(r => [r.p1Latency.p50]);
  const allP2Latencies = results.flatMap(r => [r.p2Latency.p50]);

  const totalInvalid = results.reduce((sum, r) => sum + r.p1Invalid + r.p2Invalid, 0);
  const totalCrashes = results.reduce((sum, r) => sum + r.p1Crashes + r.p2Crashes, 0);

  const winRate = config1Wins / (config1Wins + config2Wins + ties);
  const wilson = wilsonScore(config1Wins, config1Wins + config2Wins + ties);

  return {
    config1: config1Path,
    config2: config2Path,
    games: results.length,
    config1Wins,
    config2Wins,
    ties,
    winRate,
    wilsonLower: wilson.lower,
    wilsonUpper: wilson.upper,
    avgTurns,
    p1Latency: calcLatencyStats(allP1Latencies),
    p2Latency: calcLatencyStats(allP2Latencies),
    totalInvalid,
    totalCrashes,
  };
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.log('Usage: npx tsx src/eval/belief-eval.ts <config1> <config2> [games] [startSeed]');
    console.log('Example: npx tsx src/eval/belief-eval.ts configs/exact-1ply-qw-belief.yaml configs/exact-1ply-qw.yaml 800');
    process.exit(1);
  }

  const config1 = args[0];
  const config2 = args[1];
  const games = parseInt(args[2] || '800');
  const startSeed = parseInt(args[3] || '1');

  console.log('Loading data...');
  await dataLoader.load(gen9RandomBattle);
  console.log(`Loaded ${dataLoader.getStats().length || Object.keys(dataLoader.getStats()).length} species`);

  const result = await runEvaluation(config1, config2, games, startSeed);

  console.log('\n=== EVALUATION RESULTS ===');
  console.log(`Config 1: ${result.config1}`);
  console.log(`Config 2: ${result.config2}`);
  console.log(`Total games: ${result.games}`);
  console.log(`Config 1 wins: ${result.config1Wins} (${(result.winRate * 100).toFixed(2)}%)`);
  console.log(`Config 2 wins: ${result.config2Wins}`);
  console.log(`Ties: ${result.ties}`);
  console.log(`Win rate: ${(result.winRate * 100).toFixed(2)}%`);
  console.log(`Wilson 95% CI: [${(result.wilsonLower * 100).toFixed(2)}%, ${(result.wilsonUpper * 100).toFixed(2)}%]`);
  console.log(`Average turns: ${result.avgTurns.toFixed(1)}`);
  console.log(`Config 1 latency: p50=${result.p1Latency.p50}ms, p99=${result.p1Latency.p99}ms`);
  console.log(`Config 2 latency: p50=${result.p2Latency.p50}ms, p99=${result.p2Latency.p99}ms`);
  console.log(`Total invalid choices: ${result.totalInvalid}`);
  console.log(`Total crashes: ${result.totalCrashes}`);
  console.log('\n=== GUARDRAILS ===');
  console.log(`Invalid choices: ${result.totalInvalid === 0 ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Crashes: ${result.totalCrashes === 0 ? '✓ PASS' : '✗ FAIL'}`);
  
  if (result.totalInvalid > 0 || result.totalCrashes > 0) {
    console.log('\n⚠ EVALUATION FAILED GUARDRAILS');
    process.exit(1);
  }

  console.log('\n✓ EVALUATION COMPLETE');
}

main().catch(err => {
  console.error('Evaluation failed:', err);
  process.exit(1);
});
