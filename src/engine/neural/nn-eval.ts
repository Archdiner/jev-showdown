/**
 * Neural network evaluator for exact search.
 * Replaces hpEval/fittedTeamEval as the leaf evaluation function.
 */

import type { Battle } from '@pkmn/sim';
import type { SideId } from '../exact/battle-utils.js';
import { extractFeatures } from './features.js';
import { forwardPass, loadWeights, type MLPWeights } from './inference.js';
import fs from 'fs';
import path from 'path';

let cachedWeights: MLPWeights | null = null;
let weightsPath: string | null = null;

/**
 * Load neural network weights from disk.
 * This is called once at startup and cached.
 */
export function loadNNWeights(modelPath: string): void {
  if (cachedWeights && weightsPath === modelPath) {
    return; // Already loaded this model
  }
  
  const fullPath = path.resolve(modelPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Neural network weights not found at ${fullPath}`);
  }
  
  const weightsJson = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
  cachedWeights = loadWeights(weightsJson);
  weightsPath = modelPath;
  
  console.log(`[nn-eval] Loaded weights from ${modelPath}`);
  console.log(`[nn-eval] Architecture: ${cachedWeights.inputDim} -> ${cachedWeights.hidden1} -> ${cachedWeights.hidden2} -> 1`);
}

/**
 * Evaluate a battle position using the neural network.
 * Returns a score in the same scale as hpEval: roughly [-10, 10] for normal positions,
 * with ±1000 reserved for terminal wins/losses.
 * 
 * The network outputs a value in [-1, 1] representing win probability (scaled).
 * We multiply by 10 to put it in a comparable scale to hpEval.
 */
export function nnEval(battle: Battle, side: SideId): number {
  // Check for terminal states first
  if (battle.ended && battle.winner) {
    const me = battle.getSide(side);
    return battle.winner === me.name ? 1000 : -1000;
  }
  
  // Ensure weights are loaded
  if (!cachedWeights) {
    throw new Error('Neural network weights not loaded. Call loadNNWeights() first.');
  }
  
  // Extract features
  const { features } = extractFeatures(battle, side);
  
  // Run inference
  const rawValue = forwardPass(features, cachedWeights);
  
  // Scale to match hpEval range
  // rawValue is in [-1, 1], we scale it to roughly [-10, 10]
  return rawValue * 10;
}

/**
 * Check if neural network weights are loaded.
 */
export function isNNLoaded(): boolean {
  return cachedWeights !== null;
}

/**
 * Get the current model path.
 */
export function getModelPath(): string | null {
  return weightsPath;
}
