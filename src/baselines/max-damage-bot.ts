import { Action, GameState } from '../types/index.js';
import { Pokemon, Move } from '@smogon/calc';
import { damageCalc } from '../engine/damage-calc.js';

export class MaxDamageBot {
  selectAction(state: GameState, legalMoves: Action[]): Action {
    const moves = legalMoves.filter(a => a.type === 'move');
    
    if (moves.length === 0) {
      return legalMoves[0] || { type: 'move', moveIndex: 1 };
    }

    let bestMove = moves[0];
    let maxDamage = -1;

    for (const move of moves) {
      const damage = this.estimateDamage(state, move);
      if (damage > maxDamage) {
        maxDamage = damage;
        bestMove = move;
      }
    }

    return bestMove;
  }

  private estimateDamage(state: GameState, action: Action): number {
    if (action.type !== 'move') return 0;

    const basePower = 80;
    
    return basePower + Math.random() * 20;
  }
}
