/**
 * Simple 1-ply search with basic damage calculation
 * No Battle objects - just type chart and base power
 * 
 * This is the BASELINE for ablation study.
 * Should easily beat random (target >=90%)
 */

import { Action, GameState, PokemonBelief } from '../types/index.js';
import { Format } from '../types/format.js';
import { Dex } from '@pkmn/sim';

export interface Simple1PlyConfig {
  opponentModel: 'uniform' | 'max-damage';
}

export class Simple1Ply {
  private format: Format;
  private config: Simple1PlyConfig;

  constructor(format: Format, config: Simple1PlyConfig = { opponentModel: 'uniform' }) {
    this.format = format;
    this.config = config;
  }

  async search(state: GameState, legalActions: Action[]): Promise<Action> {
    if (legalActions.length === 0) {
      return { type: 'move', moveIndex: 1 };
    }
    
    if (legalActions.length === 1) {
      return legalActions[0];
    }

    // Evaluate each action
    let bestAction = legalActions[0];
    let bestScore = -Infinity;

    for (const myAction of legalActions) {
      const score = this.evaluateAction(state, myAction);
      
      if (score > bestScore) {
        bestScore = score;
        bestAction = myAction;
      }
    }

    return bestAction;
  }

  /**
   * Evaluate an action by averaging over opponent responses
   */
  private evaluateAction(state: GameState, myAction: Action): number {
    const oppActions = this.getOpponentActions(state);
    
    if (oppActions.length === 0) {
      return this.evaluateState(state);
    }

    let totalScore = 0;
    let totalWeight = 0;

    for (const oppActionData of oppActions) {
      const resultState = this.applyActions(state, myAction, oppActionData.action);
      const score = this.evaluateState(resultState);
      const weight = this.config.opponentModel === 'max-damage' ? oppActionData.weight : 1.0;
      
      totalScore += score * weight;
      totalWeight += weight;
    }

    return totalWeight > 0 ? totalScore / totalWeight : 0;
  }

  /**
   * Get opponent actions with optional weighting
   */
  private getOpponentActions(state: GameState): Array<{ action: Action; weight: number }> {
    const actions: Array<{ action: Action; weight: number }> = [];
    const oppActive = state.opponentTeam[state.opponentActive];

    if (!oppActive || oppActive.species === 'Unknown') {
      return [{ action: { type: 'move', moveIndex: 1 }, weight: 1.0 }];
    }

    const myActive = state.myTeam[state.myActive];
    if (!myActive) {
      return [{ action: { type: 'move', moveIndex: 1 }, weight: 1.0 }];
    }

    const moves = Array.from(oppActive.revealedMoves || []);
    
    // For max-damage model, weight by expected damage
    if (this.config.opponentModel === 'max-damage' && moves.length > 0) {
      for (let i = 0; i < moves.length; i++) {
        const move = moves[i];
        const damage = this.calculateDamage(oppActive, myActive, move);
        actions.push({
          action: { type: 'move', moveIndex: i + 1 },
          weight: damage > 0 ? damage : 0.1,
        });
      }
    } else {
      // Uniform model
      for (let i = 0; i < Math.min(moves.length, 4); i++) {
        actions.push({
          action: { type: 'move', moveIndex: i + 1 },
          weight: 1.0,
        });
      }
    }

    // Add one switch option
    if (state.opponentTeam.length > 1) {
      actions.push({
        action: { type: 'switch', switchIndex: 2 },
        weight: 0.2,  // Low weight for switching
      });
    }

    return actions.length > 0 ? actions : [{ action: { type: 'move', moveIndex: 1 }, weight: 1.0 }];
  }

  /**
   * Apply both actions and return resulting state
   */
  private applyActions(state: GameState, myAction: Action, oppAction: Action): GameState {
    const newState = this.cloneState(state);
    
    const myMon = newState.myTeam[newState.myActive];
    const oppMon = newState.opponentTeam[newState.opponentActive];

    if (!myMon || !oppMon) return newState;

    // Determine move order (simplified - just use speed)
    const mySpeed = myMon.stats?.spe || 100;
    const oppSpeed = oppMon.stats?.spe || 100;
    const iGoFirst = mySpeed > oppSpeed;

    // Handle switches
    if (myAction.type === 'switch' && myAction.switchIndex >= 1 && myAction.switchIndex <= newState.myTeam.length) {
      newState.myActive = myAction.switchIndex - 1;
    }
    if (oppAction.type === 'switch' && oppAction.switchIndex >= 1 && oppAction.switchIndex <= newState.opponentTeam.length) {
      newState.opponentActive = oppAction.switchIndex - 1;
    }

    // Apply moves in speed order
    if (iGoFirst) {
      this.applyMove(newState, 'my', myAction);
      if (newState.opponentTeam[newState.opponentActive].currentHp! > 0) {
        this.applyMove(newState, 'opp', oppAction);
      }
    } else {
      this.applyMove(newState, 'opp', oppAction);
      if (newState.myTeam[newState.myActive].currentHp! > 0) {
        this.applyMove(newState, 'my', myAction);
      }
    }

    return newState;
  }

  /**
   * Apply a single move
   */
  private applyMove(state: GameState, side: 'my' | 'opp', action: Action): void {
    if (action.type !== 'move') return;

    const attacker = side === 'my' ? state.myTeam[state.myActive] : state.opponentTeam[state.opponentActive];
    const defender = side === 'my' ? state.opponentTeam[state.opponentActive] : state.myTeam[state.myActive];

    if (!attacker || !defender) return;

    const moves = Array.from(attacker.revealedMoves || []);
    const move = moves[action.moveIndex - 1];

    if (!move) return;

    const damage = this.calculateDamage(attacker, defender, move);
    
    if (damage > 0) {
      const newHp = Math.max(0, (defender.currentHp || defender.maxHp || 0) - damage);
      
      if (side === 'my') {
        state.opponentTeam[state.opponentActive].currentHp = newHp;
      } else {
        state.myTeam[state.myActive].currentHp = newHp;
      }
    }
  }

  /**
   * Calculate damage using type chart and stats
   */
  private calculateDamage(attacker: PokemonBelief, defender: PokemonBelief, moveName: string): number {
    const moveData = Dex.moves.get(moveName);
    
    if (!moveData || !attacker.stats || !defender.stats || !defender.maxHp) {
      return 0;
    }

    // Status moves don't do damage
    if (moveData.category === 'Status') {
      return 0;
    }

    // Handle variable base power moves
    let basePower = moveData.basePower;
    if (basePower === 0 || basePower === 1) {
      // Variable power moves - use average
      if (moveName.toLowerCase().includes('grassknot') || moveName.toLowerCase().includes('lowkick')) {
        basePower = 80;  // Reasonable average
      } else if (moveName.toLowerCase().includes('gyroball')) {
        basePower = 60;
      } else {
        return 0;  // Unknown variable power
      }
    }

    const isPhysical = moveData.category === 'Physical';
    const attackStat = isPhysical ? attacker.stats.atk : attacker.stats.spa;
    const defenseStat = isPhysical ? defender.stats.def : defender.stats.spd;

    // Get type effectiveness
    const defenderTypes = this.getTypes(defender.species);
    const effectiveness = this.getEffectiveness(moveData.type, defenderTypes);

    // If immune, damage is 0
    if (effectiveness === 0) {
      return 0;
    }

    // Simplified damage formula (based on Gen 9 mechanics but simplified)
    // Damage = ((2 * Level / 5 + 2) * Power * A/D / 50 + 2) * Modifiers
    const level = attacker.level || 80;
    const baseDamage = ((2 * level / 5 + 2) * basePower * attackStat / defenseStat / 50 + 2);
    const damage = baseDamage * effectiveness;

    return Math.round(damage);
  }

  /**
   * Get type effectiveness multiplier
   * damageTaken on DEFENDER type tells how that type takes damage from attacker type
   * 0 = normal, 1 = SUPER EFFECTIVE, 2 = not very effective, 3 = immune
   */
  private getEffectiveness(moveType: string, defenderTypes: string[]): number {
    let effectiveness = 1.0;
    
    for (const defType of defenderTypes) {
      // Look at defender type's damageTaken to see how it takes damage from move type
      const defTypeData = Dex.types.get(defType);
      if (defTypeData && defTypeData.damageTaken) {
        const value = defTypeData.damageTaken[moveType];
        if (value === 3) effectiveness *= 0;  // Immune
        else if (value === 1) effectiveness *= 2;  // Super effective
        else if (value === 2) effectiveness *= 0.5;  // Not very effective
        // 0 or undefined = normal (1x)
      }
    }
    
    return effectiveness;
  }

  /**
   * Get Pokemon types
   */
  private getTypes(species: string): string[] {
    const speciesData = Dex.species.get(species);
    if (speciesData && speciesData.types) {
      return speciesData.types;
    }
    return ['Normal'];
  }

  /**
   * Evaluate a game state
   * Returns score from our perspective (higher is better for us)
   */
  private evaluateState(state: GameState): number {
    let score = 0;

    // HP differential (weighted by max HP to normalize)
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

    // Normalize HP sums to 0-1 range
    const myHpFraction = myMaxHpSum > 0 ? myHpSum / myMaxHpSum : 0;
    const oppHpFraction = oppMaxHpSum > 0 ? oppHpSum / oppMaxHpSum : 0;

    // HP differential (weight: 100)
    score += (myHpFraction - oppHpFraction) * 100;

    // Faint count differential (weight: 300 per faint)
    score += (myAlive - oppAlive) * 300;

    // Bonus for having active mon alive
    if (state.myTeam[state.myActive]?.currentHp && state.myTeam[state.myActive].currentHp! > 0) {
      score += 50;
    }
    if (state.opponentTeam[state.opponentActive]?.currentHp && state.opponentTeam[state.opponentActive].currentHp! > 0) {
      score -= 50;
    }

    return score;
  }

  private cloneState(state: GameState): GameState {
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
}
