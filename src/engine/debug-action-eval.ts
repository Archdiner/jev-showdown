#!/usr/bin/env node

/**
 * Debug action evaluation for a specific test
 */

import { gen9RandomBattle } from '../formats/gen9-randombattle.js';
import { dataLoader } from '../data/data-loader.js';
import { expandedDiagnosticTests } from './expanded-diagnostics.js';
import { GameState, Action, PokemonBelief } from '../types/index.js';
import { Dex } from '@pkmn/sim';

// Copy relevant parts of Simple1Ply to debug
async function debugActionEval(testName: string) {
  await dataLoader.load(gen9RandomBattle);

  const test = expandedDiagnosticTests.find(t => t.name === testName);
  if (!test) {
    console.log(`Test '${testName}' not found`);
    return;
  }

  console.log(`\n=== Debugging Action Evaluation: ${test.name} ===\n`);

  const state = test.state;
  const myMon = state.myTeam[state.myActive];
  const oppMon = state.opponentTeam[state.opponentActive];

  console.log(`Setup:`);
  console.log(`  My: ${myMon.species} (HP: ${myMon.currentHp}/${myMon.maxHp}, Spe: ${myMon.stats?.spe})`);
  console.log(`  Opp: ${oppMon.species} (HP: ${oppMon.currentHp}/${oppMon.maxHp}, Spe: ${oppMon.stats?.spe})\n`);

  // Evaluate each legal action
  for (const myAction of test.legalActions) {
    console.log(`\nEvaluating action: ${JSON.stringify(myAction)}`);
    
    if (myAction.type === 'move') {
      const moves = Array.from(myMon.revealedMoves);
      const moveName = moves[myAction.moveIndex - 1];
      console.log(`  Move: ${moveName}`);

      // Calculate damage to opponent
      const myDamage = calculateDamage(myMon, oppMon, moveName);
      console.log(`  Damage to opponent: ${myDamage}`);
    }

    // Sample opponent actions
    const oppMoves = Array.from(oppMon.revealedMoves);
    console.log(`  Opponent will respond with:`);

    let totalScore = 0;
    for (let i = 0; i < oppMoves.length; i++) {
      const oppAction = { type: 'move' as const, moveIndex: i + 1 };
      const oppMoveName = oppMoves[i];
      
      // Calculate damage to us
      const oppDamage = calculateDamage(oppMon, myMon, oppMoveName);
      console.log(`    ${oppMoveName}: ${oppDamage} damage to us`);

      // Simulate the turn
      const resultState = applyActions(state, myAction, oppAction);
      const score = evaluateState(resultState);
      
      console.log(`      Result: My HP=${resultState.myTeam[resultState.myActive].currentHp}, Opp HP=${resultState.opponentTeam[resultState.opponentActive].currentHp}, Score=${score.toFixed(1)}`);
      
      totalScore += score;
    }

    const avgScore = totalScore / oppMoves.length;
    console.log(`  Average score: ${avgScore.toFixed(1)}`);
  }
}

function calculateDamage(attacker: PokemonBelief, defender: PokemonBelief, moveName: string): number {
  const moveData = Dex.moves.get(moveName);
  
  if (!moveData || !attacker.stats || !defender.stats || !defender.maxHp) {
    return 0;
  }

  if (moveData.category === 'Status') {
    return 0;
  }

  let basePower = moveData.basePower;
  if (basePower === 0 || basePower === 1) {
    if (moveName.toLowerCase().includes('grassknot') || moveName.toLowerCase().includes('lowkick')) {
      basePower = 80;
    } else {
      return 0;
    }
  }

  const isPhysical = moveData.category === 'Physical';
  const attackStat = isPhysical ? attacker.stats.atk : attacker.stats.spa;
  const defenseStat = isPhysical ? defender.stats.def : defender.stats.spd;

  const effectiveness = getEffectiveness(moveData.type, defender.species);

  if (effectiveness === 0) {
    return 0;
  }

  const level = attacker.level || 80;
  const baseDamage = ((2 * level / 5 + 2) * basePower * attackStat / defenseStat / 50 + 2);
  const damage = baseDamage * effectiveness;

  return Math.round(damage);
}

function getEffectiveness(moveType: string, defenderSpecies: string): number {
  const defenderTypes = Dex.species.get(defenderSpecies).types;
  let effectiveness = 1.0;
  
  for (const defType of defenderTypes) {
    const defTypeData = Dex.types.get(defType);
    if (defTypeData && defTypeData.damageTaken) {
      const value = defTypeData.damageTaken[moveType];
      if (value === 3) effectiveness *= 0;
      else if (value === 1) effectiveness *= 2;
      else if (value === 2) effectiveness *= 0.5;
    }
  }
  
  return effectiveness;
}

function applyActions(state: GameState, myAction: Action, oppAction: Action): GameState {
  const newState = cloneState(state);
  
  const myMon = newState.myTeam[newState.myActive];
  const oppMon = newState.opponentTeam[newState.opponentActive];

  if (!myMon || !oppMon) return newState;

  const mySpeed = myMon.stats?.spe || 100;
  const oppSpeed = oppMon.stats?.spe || 100;
  const iGoFirst = mySpeed > oppSpeed;

  // Apply moves in speed order
  if (iGoFirst) {
    applyMove(newState, 'my', myAction);
    if (newState.opponentTeam[newState.opponentActive].currentHp! > 0) {
      applyMove(newState, 'opp', oppAction);
    }
  } else {
    applyMove(newState, 'opp', oppAction);
    if (newState.myTeam[newState.myActive].currentHp! > 0) {
      applyMove(newState, 'my', myAction);
    }
  }

  return newState;
}

function applyMove(state: GameState, side: 'my' | 'opp', action: Action): void {
  if (action.type !== 'move') return;

  const attacker = side === 'my' ? state.myTeam[state.myActive] : state.opponentTeam[state.opponentActive];
  const defender = side === 'my' ? state.opponentTeam[state.opponentActive] : state.myTeam[state.myActive];

  if (!attacker || !defender) return;

  const moves = Array.from(attacker.revealedMoves || []);
  const move = moves[action.moveIndex - 1];

  if (!move) return;

  const damage = calculateDamage(attacker, defender, move);
  
  if (damage > 0) {
    const newHp = Math.max(0, (defender.currentHp || defender.maxHp || 0) - damage);
    
    if (side === 'my') {
      state.opponentTeam[state.opponentActive].currentHp = newHp;
    } else {
      state.myTeam[state.myActive].currentHp = newHp;
    }
  }
}

function evaluateState(state: GameState): number {
  let score = 0;

  let myHpSum = 0;
  let myMaxHpSum = 0;
  let myAlive = 0;

  for (const mon of state.myTeam) {
    if (mon.maxHp && mon.maxHp > 0) {
      myMaxHpSum += mon.maxHp;
      myHpSum += mon.currentHp || 0;
      if ((mon.currentHp || 0) > 0) {
        myAlive++;
      }
    }
  }

  let oppHpSum = 0;
  let oppMaxHpSum = 0;
  let oppAlive = 0;

  for (const mon of state.opponentTeam) {
    if (mon.maxHp && mon.maxHp > 0) {
      oppMaxHpSum += mon.maxHp;
      oppHpSum += mon.currentHp || 0;
      if ((mon.currentHp || 0) > 0) {
        oppAlive++;
      }
    }
  }

  const myHpFraction = myMaxHpSum > 0 ? myHpSum / myMaxHpSum : 0;
  const oppHpFraction = oppMaxHpSum > 0 ? oppHpSum / oppMaxHpSum : 0;

  score += (myHpFraction - oppHpFraction) * 100;
  score += (myAlive - oppAlive) * 300;

  if (state.myTeam[state.myActive]?.currentHp && state.myTeam[state.myActive].currentHp! > 0) {
    score += 50;
  }
  if (state.opponentTeam[state.opponentActive]?.currentHp && state.opponentTeam[state.opponentActive].currentHp! > 0) {
    score -= 50;
  }

  return score;
}

function cloneState(state: GameState): GameState {
  return {
    ...state,
    myTeam: state.myTeam.map(mon => ({
      ...mon,
      revealedMoves: new Set(mon.revealedMoves),
      possibleSets: new Map(mon.possibleSets),
    })),
    opponentTeam: state.opponentTeam.map(mon => ({
      ...mon,
      revealedMoves: new Set(mon.revealedMoves),
      possibleSets: new Map(mon.possibleSets),
    })),
    field: { ...state.field, screens: { ...state.field.screens } },
    hazards: {
      my: { ...state.hazards.my },
      opponent: { ...state.hazards.opponent },
    },
  };
}

const testName = process.argv[2] || '07-avoid-immune-move';
debugActionEval(testName).catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
