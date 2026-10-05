#!/usr/bin/env node
/**
 * Simple single-threaded data generator for neural evaluation.
 * Plays games sequentially and logs positions with features.
 */

import { Teams } from '@pkmn/sim';
import { TeamGenerators } from '@pkmn/randoms';
import fs from 'fs';
import path from 'path';
import { extractFeatures } from '../engine/neural/features.js';
import { runGame, type GameResult } from './game.js';
import { type SideId } from '../engine/exact/battle-utils.js';
import { dataLoader } from '../data/data-loader.js';
import crypto from 'crypto';
import type { PolicySpec } from '../engine/exact/policies.js';

Teams.setGeneratorFactory(TeamGenerators);

interface PositionSample {
  seed: number;
  turn: number;
  side: SideId;
  features: number[];
  outcome: number;
  meta: {
    ourMonsRemaining: number;
    oppMonsRemaining: number;
  };
}

// Simple policy configs
const EXACT_HP: PolicySpec = {
  kind: 'exact',
  config: {
    depth: 1,
    opponentModel: 'max-damage',
    evalMode: 'hp',
    errorAsLoss: false,
    samples: 8,
  },
};

const EXACT_TEAM: PolicySpec = {
  kind: 'exact',
  config: {
    depth: 1,
    opponentModel: 'max-damage',
    evalMode: 'team',
    errorAsLoss: false,
    samples: 8,
  },
};

const MAX_DAMAGE: PolicySpec = {
  kind: 'maxdamage',
};

const RANDOM: PolicySpec = {
  kind: 'random',
};

async function generateData(numGames: number, outputPath: string, startSeed: number) {
  console.log('=== Simple Neural Data Generation ===');
  console.log(`Games: ${numGames}`);
  console.log(`Start seed: ${startSeed}`);
  console.log(`Output: ${outputPath}`);
  
  // Load data and check randbats species count
  await dataLoader.load();
  const sets = dataLoader.getSets();
  const speciesCount = Object.keys(sets).length;
  if (speciesCount !== 509) {
    throw new Error(`Randbats species count check failed: expected 509, got ${speciesCount}`);
  }
  console.log(`✓ Randbats species count: ${speciesCount}`);
  
  // Create output directory
  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  
  // Open output file
  const outStream = fs.createWriteStream(outputPath);
  
  const policies = [EXACT_HP, EXACT_TEAM, MAX_DAMAGE, RANDOM];
  const weights = [0.4, 0.2, 0.2, 0.2];
  
  let totalPositions = 0;
  let completedGames = 0;
  const startTime = Date.now();
  
  for (let i = 0; i < numGames; i++) {
    const seed = startSeed + i;
    
    // Select random policies
    const p1Policy = selectPolicy(policies, weights, Math.random());
    const p2Policy = selectPolicy(policies, weights, Math.random());
    
    // Generate teams
    const gen = Teams.getGenerator('gen9randombattle', [seed >>> 0, 0x9e3779b9, 0x12345678, 0xdecafbad] as any);
    const p1Team = gen.getTeam();
    const p2Team = gen.getTeam();
    
    // Collect positions from this game
    const positions: PositionSample[] = [];
    
    try {
      const result: GameResult = await runGame({
        index: i,
        seed,
        p1Team,
        p2Team,
        p1: p1Policy,
        p2: p2Policy,
        information: 'hidden',
        onPosition: (battle: any, side: SideId, turn: number) => {
          try {
            const { features, meta } = extractFeatures(battle, side);
            positions.push({
              seed,
              turn,
              side,
              features: Array.from(features),
              outcome: 0, // Will be filled after game ends
              meta,
            });
          } catch (err) {
            // Skip positions with extraction errors
          }
        },
      });
      
      if (!result.crashed && positions.length > 0) {
        // Label positions with game outcome
        const p1Outcome = result.winner === 'p1' ? 1.0 : result.winner === 'tie' ? 0.5 : 0.0;
        const p2Outcome = result.winner === 'p2' ? 1.0 : result.winner === 'tie' ? 0.5 : 0.0;
        
        for (const pos of positions) {
          pos.outcome = pos.side === 'p1' ? p1Outcome : p2Outcome;
          outStream.write(JSON.stringify(pos) + '\n');
        }
        
        totalPositions += positions.length;
        completedGames++;
      }
      
      if ((i + 1) % 100 === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = completedGames / elapsed;
        console.log(`  ${i + 1}/${numGames} games, ${completedGames} completed, ${totalPositions} positions (${rate.toFixed(1)} games/s)`);
      }
    } catch (err) {
      console.error(`Game ${seed} failed:`, err);
    }
  }
  
  // Wait for stream to finish
  await new Promise<void>((resolve) => {
    outStream.end(() => resolve());
  });
  
  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`\n✓ Completed ${completedGames} games in ${elapsed.toFixed(1)}s`);
  console.log(`✓ Collected ${totalPositions} positions`);
  console.log(`✓ Average: ${(totalPositions / completedGames).toFixed(1)} positions/game`);
  
  // Calculate data hash
  const dataHash = calculateFileHash(outputPath);
  console.log(`✓ Data hash: ${dataHash}`);
  
  // Write metadata
  const metaPath = outputPath.replace('.jsonl', '.meta.json');
  fs.writeFileSync(metaPath, JSON.stringify({
    numGames: completedGames,
    numPositions: totalPositions,
    speciesCount,
    dataHash,
    generatedAt: new Date().toISOString(),
    startSeed,
  }, null, 2));
  
  console.log(`✓ Metadata written to ${metaPath}`);
}

function selectPolicy(policies: PolicySpec[], weights: number[], roll: number): PolicySpec {
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const target = roll * totalWeight;
  
  let cumulative = 0;
  for (let i = 0; i < policies.length; i++) {
    cumulative += weights[i];
    if (target <= cumulative) {
      return policies[i];
    }
  }
  
  return policies[policies.length - 1];
}

function calculateFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// CLI
const numGames = parseInt(process.argv[2] || '6000', 10);
const outputPath = process.argv[3] || 'data/neural/positions.jsonl';
const startSeed = parseInt(process.argv[4] || '10000', 10);

generateData(numGames, outputPath, startSeed).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
