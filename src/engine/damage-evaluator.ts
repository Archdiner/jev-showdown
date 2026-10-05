import { GameState, Action } from '../types/index.js';
import { simulator } from './simulator.js';

export class DamageEvaluator {
  evaluateAction(state: GameState, action: Action): number {
    if (action.type === 'switch') {
      return 0;
    }

    const myActive = state.myTeam[state.myActive];
    const oppActive = state.opponentTeam[state.opponentActive];

    if (!myActive || !oppActive) return 0;

    const moves = simulator.getMoveNames(myActive);
    if (moves.length === 0) return 50;

    const moveIndex = action.moveIndex - 1;
    const move = moves[moveIndex] || moves[0] || 'Tackle';

    const damage = simulator.estimateDamage(myActive, oppActive, move);
    const effectiveness = this.getEffectiveness(move, oppActive);

    let score = damage;

    if (effectiveness > 1) {
      score *= 1.5;
    } else if (effectiveness < 1) {
      score *= 0.7;
    }

    return score;
  }

  private getEffectiveness(move: string, target: any): number {
    return 1;
  }

  getBestDamageAction(state: GameState, legalActions: Action[]): Action {
    let bestAction = legalActions[0];
    let bestDamage = -Infinity;

    for (const action of legalActions) {
      const damage = this.evaluateAction(state, action);
      if (damage > bestDamage) {
        bestDamage = damage;
        bestAction = action;
      }
    }

    return bestAction;
  }
}

export const damageEvaluator = new DamageEvaluator();
