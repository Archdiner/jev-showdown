import { Action, GameState } from '../types/index.js';
import { damageEvaluator } from '../engine/damage-evaluator.js';

export class MaxDamageBot {
  selectAction(state: GameState, legalMoves: Action[]): Action {
    const moves = legalMoves.filter(a => a.type === 'move');
    
    if (moves.length === 0) {
      return legalMoves[0] || { type: 'move', moveIndex: 1 };
    }

    return damageEvaluator.getBestDamageAction(state, moves);
  }
}
