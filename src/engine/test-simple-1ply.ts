#!/usr/bin/env node

/**
 * Test the simple 1-ply engine against diagnostic tests
 */

import { gen9RandomBattle } from '../formats/gen9-randombattle.js';
import { dataLoader } from '../data/data-loader.js';
import { Simple1Ply } from './simple-1ply.js';
import { expandedDiagnosticTests } from './expanded-diagnostics.js';

async function main() {
  console.log('=== Testing Simple 1-Ply Engine ===\n');
  console.log('Loading data...');
  await dataLoader.load(gen9RandomBattle);
  console.log('Data loaded.\n');

  const engine = new Simple1Ply(gen9RandomBattle, { opponentModel: 'uniform' });

  let passed = 0;
  let failed = 0;

  for (const test of expandedDiagnosticTests) {
    console.log(`Running: ${test.name}`);
    console.log(`  Reason: ${test.reason}`);

    try {
      const action = await engine.search(test.state, test.legalActions);
      
      const match = JSON.stringify(action) === JSON.stringify(test.expectedAction);
      
      if (match) {
        console.log(`  ✓ PASSED`);
        console.log(`  Selected: ${JSON.stringify(action)}\n`);
        passed++;
      } else {
        console.log(`  ✗ FAILED`);
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

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Test error:', e);
  process.exit(1);
});
