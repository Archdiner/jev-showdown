#!/usr/bin/env node

/**
 * Debug why RobustSearch fails on a specific test
 * Trace through the search tree to see what decisions it's making
 */

import { gen9RandomBattle } from '../formats/gen9-randombattle.js';
import { dataLoader } from '../data/data-loader.js';
import { expandedDiagnosticTests } from './expanded-diagnostics.js';
import { RobustSearch } from './robust-search.js';
import { Evaluator } from './evaluator.js';

async function debugTest(testName: string) {
  await dataLoader.load(gen9RandomBattle);

  const test = expandedDiagnosticTests.find(t => t.name === testName);
  if (!test) {
    console.log(`Test '${testName}' not found`);
    return;
  }

  console.log(`\n=== Debugging RobustSearch on: ${test.name} ===`);
  console.log(`Reason: ${test.reason}\n`);

  const myMon = test.state.myTeam[test.state.myActive];
  const oppMon = test.state.opponentTeam[test.state.opponentActive];
  
  console.log(`My active: ${myMon.species} (HP: ${myMon.currentHp}/${myMon.maxHp})`);
  console.log(`  Moves: ${Array.from(myMon.revealedMoves).join(', ')}\n`);

  console.log(`Opp active: ${oppMon.species} (HP: ${oppMon.currentHp}/${oppMon.maxHp})`);
  console.log(`  Moves: ${Array.from(oppMon.revealedMoves).join(', ')}\n`);

  console.log(`Legal actions: ${test.legalActions.map(a => JSON.stringify(a)).join(', ')}\n`);

  const config = {
    searchTimeMs: 5000,
    sampledWorlds: 3,
    maxDepth: 3,
    searchIterations: 1000,
    explorationConstant: 1.41,
    useTeraHeuristic: false,
    useLLMPrior: false,
  };

  const evaluator = new Evaluator();
  const engine = new RobustSearch(config, evaluator, gen9RandomBattle);

  console.log(`Running RobustSearch...`);
  const startTime = Date.now();
  const action = await engine.search(test.state, test.legalActions);
  const timeMs = Date.now() - startTime;

  console.log(`\nSearch complete (${timeMs}ms)`);
  console.log(`Expected: ${JSON.stringify(test.expectedAction)}`);
  console.log(`Got:      ${JSON.stringify(action)}`);
  console.log(`Match:    ${JSON.stringify(action) === JSON.stringify(test.expectedAction) ? '✓ PASS' : '✗ FAIL'}\n`);

  const fallbackStats = engine.getFallbackStats();
  console.log(`Fallback rate: ${(fallbackStats.fallbackRate * 100).toFixed(2)}%`);
  console.log(`  (${fallbackStats.fallbackCount}/${fallbackStats.totalCalls} calls)`);

  // Now evaluate each action with the simple evaluator to compare
  console.log(`\n=== Simple evaluation (for comparison) ===`);
  for (const legalAction of test.legalActions) {
    const evalResult = evaluator.evaluate(test.state);
    console.log(`Action ${JSON.stringify(legalAction)}: base score = ${evalResult.score.toFixed(1)}`);
  }
}

const testName = process.argv[2] || '02-dont-switch-into-ko';
debugTest(testName).catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
