#!/usr/bin/env node

/**
 * Debug the simple 1-ply engine on a specific test
 */

import { gen9RandomBattle } from '../formats/gen9-randombattle.js';
import { dataLoader } from '../data/data-loader.js';
import { Simple1Ply } from './simple-1ply.js';
import { expandedDiagnosticTests } from './expanded-diagnostics.js';
import { Dex } from '@pkmn/sim';

async function debugTest(testName: string) {
  await dataLoader.load(gen9RandomBattle);

  const test = expandedDiagnosticTests.find(t => t.name === testName);
  if (!test) {
    console.log(`Test '${testName}' not found`);
    return;
  }

  console.log(`\n=== Debugging Test: ${test.name} ===`);
  console.log(`Reason: ${test.reason}\n`);

  // Print state
  const myMon = test.state.myTeam[test.state.myActive];
  const oppMon = test.state.opponentTeam[test.state.opponentActive];
  
  console.log(`My active: ${myMon.species} (HP: ${myMon.currentHp}/${myMon.maxHp})`);
  console.log(`  Moves: ${Array.from(myMon.revealedMoves).join(', ')}`);
  console.log(`  Stats: ${JSON.stringify(myMon.stats)}\n`);

  console.log(`Opp active: ${oppMon.species} (HP: ${oppMon.currentHp}/${oppMon.maxHp})`);
  console.log(`  Moves: ${Array.from(oppMon.revealedMoves).join(', ')}`);
  console.log(`  Stats: ${JSON.stringify(oppMon.stats)}\n`);

  // Check type effectiveness manually
  console.log(`Type analysis:`);
  const myMoves = Array.from(myMon.revealedMoves);
  const oppTypes = Dex.species.get(oppMon.species).types;
  console.log(`  Opponent types: ${oppTypes.join(', ')}\n`);

  for (let i = 0; i < myMoves.length; i++) {
    const move = myMoves[i];
    const moveData = Dex.moves.get(move);
    
    // Handle variable base power
    let basePower = moveData.basePower;
    if (basePower === 0 || basePower === 1) {
      if (move.toLowerCase().includes('grassknot') || move.toLowerCase().includes('lowkick')) {
        basePower = 80;
      }
    }
    
    console.log(`  Move ${i + 1}: ${move} (${moveData.type}, ${moveData.category}, BP: ${basePower})`);
    
    let effectiveness = 1.0;
    for (const defType of oppTypes) {
      // Use DEFENDER type's damageTaken
      const defTypeData = Dex.types.get(defType);
      if (defTypeData && defTypeData.damageTaken) {
        const value = defTypeData.damageTaken[moveData.type];
        console.log(`    ${moveData.type} vs ${defType}: ${value} (0=normal, 1=SE, 2=NVE, 3=Immune)`);
        if (value === 3) effectiveness *= 0;
        else if (value === 1) effectiveness *= 2;
        else if (value === 2) effectiveness *= 0.5;
      }
    }
    console.log(`    Total effectiveness: ${effectiveness}x`);

    // Calculate estimated damage
    if (moveData.category !== 'Status' && myMon.stats && oppMon.stats && basePower > 0) {
      const isPhysical = moveData.category === 'Physical';
      const attackStat = isPhysical ? myMon.stats.atk : myMon.stats.spa;
      const defenseStat = isPhysical ? oppMon.stats.def : oppMon.stats.spd;
      const level = myMon.level || 80;
      const baseDamage = ((2 * level / 5 + 2) * basePower * attackStat / defenseStat / 50 + 2);
      const damage = baseDamage * effectiveness;
      console.log(`    Est. damage: ${Math.round(damage)} (${(damage / oppMon.maxHp! * 100).toFixed(1)}%)\n`);
    } else {
      console.log(`    (No damage calculation)\n`);
    }
  }

  // Now run the engine
  const engine = new Simple1Ply(gen9RandomBattle, { opponentModel: 'uniform' });
  const action = await engine.search(test.state, test.legalActions);

  console.log(`\nExpected: ${JSON.stringify(test.expectedAction)}`);
  console.log(`Got:      ${JSON.stringify(action)}`);
  console.log(`Match:    ${JSON.stringify(action) === JSON.stringify(test.expectedAction) ? '✓ PASS' : '✗ FAIL'}`);
}

const testName = process.argv[2] || '07-avoid-immune-move';
debugTest(testName).catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
