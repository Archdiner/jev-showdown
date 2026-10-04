/**
 * Ablation Study - Version 1: Simplest Possible Engine
 * 
 * - 1-ply lookahead only
 * - No opponent modeling (uniform action distribution)
 * - Simplest eval: HP fraction difference + faint count
 * - No determinized worlds, no behavioral weighting
 */

import { Action, GameState, PokemonBelief } from '../types/index.js';
import { Format } from '../types/format.js';
import { Dex } from '@pkmn/sim';

export interface SimpleSearchConfig {
  maxActionsPerSide: number;  // Limit actions sampled for speed
}

export class SimpleSearch {
  private format: Format;
  private config: SimpleSearchConfig;

  constructor(format: Format, config: SimpleSearchConfig = { maxActionsPerSide: 4 }) {
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

    // Evaluate each of our legal actions
    let bestAction = legalActions[0];
    let bestScore = -Infinity;

    for (const myAction of legalActions) {
      // Sample opponent actions uniformly
      const oppActions = this.getOpponentActions(state);
      
      // Average outcome over all opponent responses
      let totalScore = 0;
      for (const oppAction of oppActions) {
        const resultState = this.simulateSimple(state, myAction, oppAction);
        const score = this.evaluateSimple(resultState);
        totalScore += score;
      }
      
      const avgScore = oppActions.length > 0 ? totalScore / oppActions.length : 0;
      
      if (avgScore > bestScore) {
        bestScore = avgScore;
        bestAction = myAction;
      }
    }

    return bestAction;
  }

  /**
   * Get opponent actions (uniform sampling)
   */
  private getOpponentActions(state: GameState): Action[] {
    const actions: Action[] = [];
    const oppActive = state.opponentTeam[state.opponentActive];

    if (!oppActive || oppActive.species === 'Unknown') {
      return [{ type: 'move', moveIndex: 1 }];
    }

    // Sample moves
    const moves = Array.from(oppActive.revealedMoves || []);
    const numMoves = Math.min(moves.length, this.config.maxActionsPerSide);
    
    for (let i = 0; i < numMoves; i++) {
      actions.push({ type: 'move', moveIndex: i + 1 });
    }

    // One switch option
    if (state.opponentTeam.length > 1) {
      actions.push({ type: 'switch', switchIndex: 2 });
    }

    return actions.length > 0 ? actions : [{ type: 'move', moveIndex: 1 }];
  }

  /**
   * Simple simulation without @pkmn/sim - just estimate damage
   */
  private simulateSimple(state: GameState, myAction: Action, oppAction: Action): GameState {
    const newState = this.cloneState(state);
    
    const myMon = newState.myTeam[newState.myActive];
    const oppMon = newState.opponentTeam[newState.opponentActive];

    if (!myMon || !oppMon) return newState;

    // Handle switches first
    if (myAction.type === 'switch' && myAction.switchIndex >= 1 && myAction.switchIndex <= newState.myTeam.length) {
      newState.myActive = myAction.switchIndex - 1;
    }
    if (oppAction.type === 'switch' && oppAction.switchIndex >= 1 && oppAction.switchIndex <= newState.opponentTeam.length) {
      newState.opponentActive = oppAction.switchIndex - 1;
    }

    // If both are moves, calculate damage
    if (myAction.type === 'move' && oppAction.type === 'move') {
      const myMoves = Array.from(myMon.revealedMoves || []);
      const oppMoves = Array.from(oppMon.revealedMoves || []);

      const myMove = myMoves[myAction.moveIndex - 1];
      const oppMove = oppMoves[oppAction.moveIndex - 1];

      if (myMove && oppMon.currentHp) {
        const damage = this.estimateDamage(myMon, oppMon, myMove);
        newState.opponentTeam[newState.opponentActive].currentHp = Math.max(0, oppMon.currentHp - damage);
      }

      if (oppMove && myMon.currentHp) {
        const damage = this.estimateDamage(oppMon, myMon, oppMove);
        newState.myTeam[newState.myActive].currentHp = Math.max(0, myMon.currentHp - damage);
      }
    }

    return newState;
  }

  /**
   * Estimate damage (very simple calculation)
   */
  private estimateDamage(attacker: PokemonBelief, defender: PokemonBelief, moveName: string): number {
    const moveData = Dex.moves.get(moveName);
    
    if (!moveData || !moveData.basePower || !attacker.stats || !defender.stats || !defender.maxHp) {
      return 0;
    }

    const isPhysical = moveData.category === 'Physical';
    const attackStat = isPhysical ? attacker.stats.atk : attacker.stats.spa;
    const defenseStat = isPhysical ? defender.stats.def : defender.stats.spd;

    // Very basic damage formula (not accurate but fast)
    const damage = (attackStat / defenseStat) * moveData.basePower * 0.4;
    
    return Math.min(damage, defender.currentHp || defender.maxHp);
  }

  /**
   * Simple evaluation: HP fraction difference + faint count
   */
  private evaluateSimple(state: GameState): number {
    let score = 0;

    // Sum HP fractions for our team
    let myHpFraction = 0;
    let myAlive = 0;
    for (const mon of state.myTeam) {
      if (mon.currentHp && mon.maxHp && mon.currentHp > 0) {
        myHpFraction += mon.currentHp / mon.maxHp;
        myAlive++;
      }
    }

    // Sum HP fractions for opponent team
    let oppHpFraction = 0;
    let oppAlive = 0;
    for (const mon of state.opponentTeam) {
      if (mon.currentHp && mon.maxHp && mon.currentHp > 0) {
        oppHpFraction += mon.currentHp / mon.maxHp;
        oppAlive++;
      }
    }

    // Score = our HP - their HP + faint differential
    score += myHpFraction - oppHpFraction;
    score += (myAlive - oppAlive) * 2;  // Each faint worth 2 HP fractions

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
