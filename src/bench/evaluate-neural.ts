#!/usr/bin/env node
/**
 * Evaluate neural network config against baseline.
 * Runs seat-swapped paired games and reports statistics.
 */

import { runGame, type GameResult, type BenchPlayer } from './game.js';
import { Teams } from '@pkmn/sim';
import { TeamGenerators } from '@pkmn/randoms';
import fs from 'fs';
import path from 'path';

Teams.setGeneratorFactory(TeamGenerators);

interface EvalConfig {
  challenger: BenchPlayer;
  baseline: BenchPlayer;
  numPairs: number;
  startSeed: number;
  outputPath: string;
}

interface EvalResult {
  challenger: {
    name: string;
    wins: number;
    losses: number;
    ties: number;
  };
  baseline: {
    name: string;
    wins: number;
    losses: number;
    ties: number;
  };
  games: number;
  pairs: number;
  crashes: number;
  invalidMoves: {
    challenger: number;
    baseline: number;
  };
  latency: {
    challengerP50: number;
    challengerP99: number;
    baselineP50: number;
    baselineP99: number;
  };
  wilsonCI: {
    winRate: number;
    lower: number;
    upper: number;
  };
}

/**
 * Wilson score confidence interval for a binomial proportion.
 */
function wilsonCI(wins: number, total: number, confidence: number = 0.95): { lower: number; upper: number } {
  if (total === 0) return { lower: 0, upper: 1 };
  
  const p = wins / total;
  const z = confidence === 0.95 ? 1.96 : 2.576; // 95% or 99%
  const denominator = 1 + z * z / total;
  const centre = (p + z * z / (2 * total)) / denominator;
  const margin = (z / denominator) * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total));
  
  return {
    lower: Math.max(0, centre - margin),
    upper: Math.min(1, centre + margin),
  };
}

/**
 * Calculate percentile from sorted array.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, index)];
}

async function evaluateConfig(config: EvalConfig): Promise<EvalResult> {
  console.log('=== Neural Eval Evaluation ===');
  console.log(`Pairs: ${config.numPairs} (${config.numPairs * 2} games total)`);
  console.log(`Start seed: ${config.startSeed}`);
  console.log(`Output: ${config.outputPath}`);
  
  const result: EvalResult = {
    challenger: {
      name: 'neural-eval',
      wins: 0,
      losses: 0,
      ties: 0,
    },
    baseline: {
      name: 'exact-1ply',
      wins: 0,
      losses: 0,
      ties: 0,
    },
    games: 0,
    pairs: 0,
    crashes: 0,
    invalidMoves: {
      challenger: 0,
      baseline: 0,
    },
    latency: {
      challengerP50: 0,
      challengerP99: 0,
      baselineP50: 0,
      baselineP99: 0,
    },
    wilsonCI: {
      winRate: 0,
      lower: 0,
      upper: 0,
    },
  };
  
  const challengerLatencies: number[] = [];
  const baselineLatencies: number[] = [];
  const gameResults: any[] = [];
  
  const startTime = Date.now();
  
  for (let i = 0; i < config.numPairs; i++) {
    const seed = config.startSeed + i;
    
    // Generate teams once for the pair
    const gen = Teams.getGenerator('gen9randombattle', [seed >>> 0, 0x9e3779b9, 0x12345678, 0xdecafbad] as any);
    const team1 = gen.getTeam();
    const team2 = gen.getTeam();
    
    // Game 1: Challenger is P1, Baseline is P2
    const game1: GameResult = await runGame({
      index: i * 2,
      seed,
      p1Team: team1,
      p2Team: team2,
      p1: config.challenger,
      p2: config.baseline,
      information: 'hidden',
    });
    
    // Game 2: Baseline is P1, Challenger is P2 (seat swapped)
    const game2: GameResult = await runGame({
      index: i * 2 + 1,
      seed,
      p1Team: team2,
      p2Team: team1,
      p1: config.baseline,
      p2: config.challenger,
      information: 'hidden',
    });
    
    // Record results
    gameResults.push(game1, game2);
    
    if (!game1.crashed && !game2.crashed) {
      // Game 1: challenger=p1, baseline=p2
      if (game1.winner === 'p1') result.challenger.wins++;
      else if (game1.winner === 'p2') result.baseline.wins++;
      else result.challenger.ties++;
      
      // Game 2: baseline=p1, challenger=p2
      if (game2.winner === 'p2') result.challenger.wins++;
      else if (game2.winner === 'p1') result.baseline.wins++;
      else result.challenger.ties++;
      
      result.pairs++;
      result.games += 2;
      
      // Latencies
      challengerLatencies.push(...game1.p1TurnTimes);
      baselineLatencies.push(...game1.p2TurnTimes);
      baselineLatencies.push(...game2.p1TurnTimes);
      challengerLatencies.push(...game2.p2TurnTimes);
      
      // Invalid moves
      result.invalidMoves.challenger += game1.p1Invalid + game2.p2Invalid;
      result.invalidMoves.baseline += game1.p2Invalid + game2.p1Invalid;
    } else {
      result.crashes++;
    }
    
    if ((i + 1) % 50 === 0) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = result.pairs / elapsed;
      console.log(`  ${i + 1}/${config.numPairs} pairs (${rate.toFixed(1)} pairs/s)`);
    }
  }
  
  // Calculate statistics
  challengerLatencies.sort((a, b) => a - b);
  baselineLatencies.sort((a, b) => a - b);
  
  result.latency.challengerP50 = percentile(challengerLatencies, 0.50);
  result.latency.challengerP99 = percentile(challengerLatencies, 0.99);
  result.latency.baselineP50 = percentile(baselineLatencies, 0.50);
  result.latency.baselineP99 = percentile(baselineLatencies, 0.99);
  
  // Wilson CI for win rate
  const wins = result.challenger.wins;
  const total = result.games;
  const ci = wilsonCI(wins, total, 0.95);
  result.wilsonCI = {
    winRate: wins / total,
    lower: ci.lower,
    upper: ci.upper,
  };
  
  result.baseline.losses = result.challenger.wins;
  result.baseline.ties = result.challenger.ties;
  
  const elapsed = (Date.now() - startTime) / 1000;
  
  console.log(`\n=== Results ===`);
  console.log(`Games: ${result.games} (${result.pairs} pairs)`);
  console.log(`Challenger wins: ${result.challenger.wins}`);
  console.log(`Baseline wins: ${result.baseline.wins}`);
  console.log(`Ties: ${result.challenger.ties}`);
  console.log(`Crashes: ${result.crashes}`);
  console.log(`\nWin rate: ${(result.wilsonCI.winRate * 100).toFixed(1)}%`);
  console.log(`Wilson 95% CI: [${(result.wilsonCI.lower * 100).toFixed(1)}%, ${(result.wilsonCI.upper * 100).toFixed(1)}%]`);
  console.log(`\nLatency (ms):`);
  console.log(`  Challenger: p50=${result.latency.challengerP50.toFixed(0)}, p99=${result.latency.challengerP99.toFixed(0)}`);
  console.log(`  Baseline: p50=${result.latency.baselineP50.toFixed(0)}, p99=${result.latency.baselineP99.toFixed(0)}`);
  console.log(`\nInvalid moves:`);
  console.log(`  Challenger: ${result.invalidMoves.challenger}`);
  console.log(`  Baseline: ${result.invalidMoves.baseline}`);
  console.log(`\nElapsed: ${elapsed.toFixed(1)}s`);
  
  // Write results
  const outDir = path.dirname(config.outputPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  
  fs.writeFileSync(config.outputPath, JSON.stringify({
    summary: result,
    games: gameResults,
    config,
    timestamp: new Date().toISOString(),
  }, null, 2));
  
  console.log(`\n✓ Results written to ${config.outputPath}`);
  
  return result;
}

// CLI
const numPairs = parseInt(process.argv[2] || '100', 10);
const outputPath = process.argv[3] || 'data/neural/eval-results.json';
const startSeed = parseInt(process.argv[4] || '20000', 10);

// TODO: This will need to be updated once we have the actual configs working
const CHALLENGER: BenchPlayer = {
  kind: 'exact',
  config: {
    depth: 1,
    opponentModel: 'max-damage',
    evalMode: 'nn' as any, // Will be 'nn' once integrated
    errorAsLoss: false,
    samples: 8,
  },
};

const BASELINE: BenchPlayer = {
  kind: 'exact',
  config: {
    depth: 1,
    opponentModel: 'max-damage',
    evalMode: 'hp',
    errorAsLoss: false,
    samples: 8,
  },
};

evaluateConfig({
  challenger: CHALLENGER,
  baseline: BASELINE,
  numPairs,
  startSeed,
  outputPath,
}).catch(err => {
  console.error('Evaluation failed:', err);
  process.exit(1);
});
