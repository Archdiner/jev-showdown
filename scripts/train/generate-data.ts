/**
 * Generate training data from self-play games.
 * Uses hidden information (honest view) for features, labeled by game outcome.
 */

import { PRNG, Teams, type PokemonSet } from '@pkmn/sim';
import { TeamGenerators } from '@pkmn/randoms';
import fs from 'fs';
import path from 'path';
import { extractFeatures } from '../../src/engine/neural/features.js';
import { runGame, type BenchPlayer, type GameResult } from '../../src/bench/game.js';
import { ensureGenerators, type SideId } from '../../src/engine/exact/battle-utils.js';
import { randbatsSpeciesCount } from '../../src/data/data-loader.js';
import crypto from 'crypto';

Teams.setGeneratorFactory(TeamGenerators);
ensureGenerators();

interface PositionSample {
  /** Seed that generated this game */
  seed: number;
  /** Turn number */
  turn: number;
  /** Which side's perspective (p1 or p2) */
  side: SideId;
  /** Feature vector */
  features: number[];
  /** Game outcome from this side's perspective: 1 = win, 0 = loss, 0.5 = tie */
  outcome: number;
  /** Metadata */
  meta: {
    ourMonsRemaining: number;
    oppMonsRemaining: number;
  };
}

interface DataGenConfig {
  numGames: number;
  outputPath: string;
  policyMix: Array<{ policy: BenchPlayer; weight: number }>;
  startSeed: number;
}

/**
 * Play one game and extract position samples from it.
 */
async function playAndExtractSamples(
  seed: number,
  p1: BenchPlayer,
  p2: BenchPlayer,
  prng: PRNG
): Promise<PositionSample[]> {
  // Generate teams
  const gen = Teams.getGenerator('gen9randombattle');
  const p1Team = gen.getTeam({ prng });
  const p2Team = gen.getTeam({ prng });
  
  const samples: PositionSample[] = [];
  let gameOutcome: 'p1' | 'p2' | 'tie' | null = null;
  
  // Play the game with hidden information, extracting features at each decision
  const result = await runGame({
    index: seed,
    seed,
    p1Team,
    p2Team,
    p1,
    p2,
    information: 'hidden',
    logDecisions: false,
    onPosition: (battle: any, side: SideId, turn: number) => {
      // Extract features from this position
      try {
        const { features, meta } = extractFeatures(battle, side);
        
        // Store the sample (outcome will be filled in later)
        samples.push({
          seed,
          turn,
          side,
          features: Array.from(features),
          outcome: 0, // Will be filled after game ends
          meta,
        });
      } catch (err) {
        // Skip positions that fail feature extraction
        console.error(`Feature extraction failed for seed ${seed}, turn ${turn}, side ${side}:`, err);
      }
    },
  });
  
  if (result.crashed) {
    return [];
  }
  
  gameOutcome = result.winner;
  
  // Determine outcome for each side and label all samples
  const p1Outcome = result.winner === 'p1' ? 1.0 : result.winner === 'tie' ? 0.5 : 0.0;
  const p2Outcome = result.winner === 'p2' ? 1.0 : result.winner === 'tie' ? 0.5 : 0.0;
  
  // Label all samples with the game outcome
  for (const sample of samples) {
    sample.outcome = sample.side === 'p1' ? p1Outcome : p2Outcome;
  }
  
  return samples;
}

/**
 * Generate training data from self-play.
 */
export async function generateData(config: DataGenConfig): Promise<void> {
  console.log('=== Neural Eval Data Generation ===');
  console.log(`Target: ${config.numGames} games`);
  console.log(`Output: ${config.outputPath}`);
  
  // Check randbats species count
  const speciesCount = randbatsSpeciesCount();
  if (speciesCount !== 509) {
    throw new Error(`Randbats species count check failed: expected 509, got ${speciesCount}`);
  }
  console.log(`✓ Randbats species count: ${speciesCount}`);
  
  // Create output directory
  const outDir = path.dirname(config.outputPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  
  // Create PRNG for game generation
  const masterPrng = new PRNG([config.startSeed, config.startSeed, config.startSeed, config.startSeed]);
  
  const allSamples: PositionSample[] = [];
  let gamesPlayed = 0;
  let positionsCollected = 0;
  
  console.log('\\nGenerating games...');
  
  for (let i = 0; i < config.numGames; i++) {
    const seed = config.startSeed + i;
    
    // Select policies for this game based on weights
    const roll1 = masterPrng.next();
    const roll2 = masterPrng.next();
    
    const p1 = selectPolicy(config.policyMix, roll1);
    const p2 = selectPolicy(config.policyMix, roll2);
    
    // Create game-specific PRNG
    const gamePrng = new PRNG([seed, seed, seed, seed]);
    
    try {
      const samples = await playAndExtractSamples(seed, p1, p2, gamePrng);
      allSamples.push(...samples);
      positionsCollected += samples.length;
      gamesPlayed++;
      
      if ((i + 1) % 100 === 0) {
        console.log(`  ${i + 1}/${config.numGames} games, ${positionsCollected} positions`);
      }
    } catch (err) {
      console.error(`Game ${seed} failed:`, err);
    }
  }
  
  console.log(`\\n✓ Played ${gamesPlayed} games`);
  console.log(`✓ Collected ${positionsCollected} positions`);
  
  // Write to JSONL
  const outStream = fs.createWriteStream(config.outputPath);
  for (const sample of allSamples) {
    outStream.write(JSON.stringify(sample) + '\\n');
  }
  outStream.end();
  
  // Calculate data hash
  const dataHash = calculateFileHash(config.outputPath);
  console.log(`✓ Data written to ${config.outputPath}`);
  console.log(`✓ Data hash: ${dataHash}`);
  
  // Write metadata
  const metaPath = config.outputPath.replace('.jsonl', '.meta.json');
  fs.writeFileSync(metaPath, JSON.stringify({
    numGames: gamesPlayed,
    numPositions: positionsCollected,
    speciesCount,
    dataHash,
    generatedAt: new Date().toISOString(),
    startSeed: config.startSeed,
    policyMix: config.policyMix,
  }, null, 2));
  
  console.log(`✓ Metadata written to ${metaPath}`);
}

function selectPolicy(mix: Array<{ policy: BenchPlayer; weight: number }>, roll: number): BenchPlayer {
  const totalWeight = mix.reduce((sum, item) => sum + item.weight, 0);
  const target = roll * totalWeight;
  
  let cumulative = 0;
  for (const item of mix) {
    cumulative += item.weight;
    if (target <= cumulative) {
      return item.policy;
    }
  }
  
  return mix[mix.length - 1].policy;
}

function calculateFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const numGames = parseInt(process.argv[2] || '6000', 10);
  const outPath = process.argv[3] || 'data/neural/positions.jsonl';
  
  generateData({
    numGames,
    outputPath: outPath,
    startSeed: 10000,
    policyMix: [
      { policy: { kind: 'exact', depth: 1, opponentModel: 'max-damage', evalMode: 'hp' }, weight: 0.4 },
      { policy: { kind: 'exact', depth: 1, opponentModel: 'max-damage', evalMode: 'team' }, weight: 0.2 },
      { policy: { kind: 'max-damage' }, weight: 0.2 },
      { policy: { kind: 'random', epsilon: 0.2 }, weight: 0.2 },
    ],
  }).catch(console.error);
}
