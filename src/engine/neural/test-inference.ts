/**
 * Test neural network inference end-to-end.
 */

import { Teams } from '@pkmn/sim';
import { TeamGenerators } from '@pkmn/randoms';
import { startRandomBattle } from '../exact/battle-utils.js';
import { loadNNWeights, nnEval } from './nn-eval.js';
import { extractFeatures } from './features.js';
import { countParameters, loadWeights } from './inference.js';
import fs from 'fs';

Teams.setGeneratorFactory(TeamGenerators);

async function testInference(weightsPath: string) {
  console.log('=== Testing Neural Network Inference ===');
  console.log(`Loading weights from: ${weightsPath}`);
  
  // Load weights
  loadNNWeights(weightsPath);
  
  // Create a test battle
  const seed = 12345;
  const gen = Teams.getGenerator('gen9randombattle', [seed >>> 0, 0x9e3779b9, 0x12345678, 0xdecafbad] as any);
  const p1Team = gen.getTeam();
  const p2Team = gen.getTeam();
  const battle = startRandomBattle(p1Team, p2Team, seed);
  
  console.log(`\nTest battle created (seed ${seed})`);
  console.log(`Turn: ${battle.turn}`);
  
  // Extract features and run inference
  const { features, meta } = extractFeatures(battle, 'p1');
  console.log(`\nExtracted features:`);
  console.log(`  Dimension: ${features.length}`);
  console.log(`  Our mons: ${meta.ourMonsRemaining}`);
  console.log(`  Opp mons: ${meta.oppMonsRemaining}`);
  
  // Run neural network eval
  const score = nnEval(battle, 'p1');
  console.log(`\nNeural eval score: ${score.toFixed(4)}`);
  
  // Load weights metadata
  const metaPath = weightsPath.replace('.json', '.meta.json');
  if (fs.existsSync(metaPath)) {
    const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    console.log(`\nModel metadata:`);
    console.log(`  Architecture: ${metadata.architecture.inputDim} -> ${metadata.architecture.hidden1} -> ${metadata.architecture.hidden2} -> 1`);
    console.log(`  Parameters: ${metadata.parameters.toLocaleString()}`);
    console.log(`  Test Brier: ${metadata.testBrier.toFixed(4)}`);
    console.log(`  Trained: ${metadata.trainedAt}`);
  }
  
  // Compute inference time
  const numTrials = 1000;
  const startTime = Date.now();
  for (let i = 0; i < numTrials; i++) {
    nnEval(battle, 'p1');
  }
  const elapsed = Date.now() - startTime;
  const avgTimeMs = elapsed / numTrials;
  const avgTimeUs = (avgTimeMs * 1000).toFixed(0);
  
  console.log(`\nPerformance (${numTrials} trials):`);
  console.log(`  Average inference time: ${avgTimeMs.toFixed(2)} ms (${avgTimeUs} µs)`);
  console.log(`  Throughput: ${(1000 / avgTimeMs).toFixed(0)} evals/sec`);
  
  // Estimate latency for full search
  const leavesPerSearch = 72; // typical for exact-1ply
  const searchOverhead = 150; // ms for clone+rollout operations
  const nnSearchTime = searchOverhead + (leavesPerSearch * avgTimeMs);
  console.log(`\nEstimated exact-1ply search latency:`);
  console.log(`  ${nnSearchTime.toFixed(1)} ms (${leavesPerSearch} leaves × ${avgTimeMs.toFixed(2)} ms + ${searchOverhead} ms overhead)`);
  
  if (nnSearchTime < 300) {
    console.log(`  ✓ Under p99 target of 300 ms`);
  } else {
    console.log(`  ✗ Exceeds p99 target of 300 ms`);
  }
  
  console.log(`\n✓ Inference test complete`);
}

// CLI
const weightsPath = process.argv[2] || 'data/neural/weights-test.json';
testInference(weightsPath).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
