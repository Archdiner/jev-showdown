#!/usr/bin/env node

/**
 * Test the RobustSearch engine (current 3-ply system) against diagnostic tests
 */

import { gen9RandomBattle } from '../formats/gen9-randombattle.js';
import { dataLoader } from '../data/data-loader.js';
import { RobustSearch } from './robust-search.js';
import { Evaluator } from './evaluator.js';
import { expandedDiagnosticTests } from './expanded-diagnostics.js';

async function main() {
  console.log('=== Testing RobustSearch Engine (Current 3-ply) ===\n');
  console.log('Loading data...');
  await dataLoader.load(gen9RandomBattle);
  console.log('Data loaded.\n');

  const config = {
    searchTimeMs: 3000,  // 3 seconds per test
    sampledWorlds: 3,
    maxDepth: 3,
    searchIterations: 1000,
    explorationConstant: 1.41,
    useTeraHeuristic: false,
    useLLMPrior: false,
  };

  const evaluator = new Evaluator();
  const engine = new RobustSearch(config, evaluator, gen9RandomBattle);

  let passed = 0;
  let failed = 0;

  for (const test of expandedDiagnosticTests) {
    console.log(`Running: ${test.name}`);
    console.log(`  Reason: ${test.reason}`);

    try {
      const startTime = Date.now();
      const action = await engine.search(test.state, test.legalActions);
      const timeMs = Date.now() - startTime;
      
      const match = JSON.stringify(action) === JSON.stringify(test.expectedAction);
      
      if (match) {
        console.log(`  ✓ PASSED (${timeMs}ms)`);
        console.log(`  Selected: ${JSON.stringify(action)}\n`);
        passed++;
      } else {
        console.log(`  ✗ FAILED (${timeMs}ms)`);
        console.log(`  Expected: ${JSON.stringify(test.expectedAction)}`);
        console.log(`  Got:      ${JSON.stringify(action)}\n`);
        failed++;
      }
    } catch (e) {
      console.log(`  ✗ ERROR: ${e}\n`);
      failed++;
    }
  }

  console.log('=== Summary ===');
  console.log(`Passed: ${passed}/${expandedDiagnosticTests.length}`);
  console.log(`Failed: ${failed}/${expandedDiagnosticTests.length}`);
  console.log(`Pass rate: ${(passed / expandedDiagnosticTests.length * 100).toFixed(1)}%`);

  const fallbackStats = engine.getFallbackStats();
  console.log(`\nFallback rate: ${(fallbackStats.fallbackRate * 100).toFixed(2)}%`);
  console.log(`  (${fallbackStats.fallbackCount}/${fallbackStats.totalCalls} calls)`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Test error:', e);
  process.exit(1);
});
