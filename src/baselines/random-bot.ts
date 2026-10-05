import { Action } from '../types/index.js';

export class RandomBot {
  selectAction(legalMoves: Action[]): Action {
    if (legalMoves.length === 0) {
      return { type: 'move', moveIndex: 1 };
    }
    return legalMoves[Math.floor(Math.random() * legalMoves.length)];
  }
}
