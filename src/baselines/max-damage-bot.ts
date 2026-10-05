import { Action, GameState } from '../types/index.js';
import { damageEvaluator } from '../engine/damage-evaluator.js';

export class MaxDamageBot {
  private debugCount = 0;

  selectAction(state: GameState, legalMoves: Action[]): Action {
    const moves = legalMoves.filter(a => a.type === 'move');
    
    if (moves.length === 0) {
      return legalMoves[0] || { type: 'move', moveIndex: 1 };
    }

    const action = damageEvaluator.getBestDamageAction(state, moves);
    
    if (this.debugCount < 3) {
      this.debugCount++;
      const myActive = state.myTeam[state.myActive];
      const oppActive = state.opponentTeam[state.opponentActive];
      console.log(`\n=== MaxDamage Debug ${this.debugCount} ===`);
      console.log(`My: ${myActive?.species || 'Unknown'}, Moves: ${Array.from(myActive?.revealedMoves || []).join(', ')}`);
      console.log(`Opp: ${oppActive?.species || 'Unknown'}`);
      console.log(`Legal moves: ${moves.length}, Chose: move ${action.type === 'move' ? action.moveIndex : 'N/A'}`);
    }
    
    return action;
  }
}
