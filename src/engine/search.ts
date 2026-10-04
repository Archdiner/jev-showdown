import { GameState, Action, BotConfig } from '../types/index.js';
import { Evaluator } from './evaluator.js';
import { simulator } from './simulator.js';

interface SearchNode {
  state: GameState;
  action: Action;
  visits: number;
  totalValue: number;
  children: SearchNode[];
  parent?: SearchNode;
}

export class SearchEngine {
  private evaluator: Evaluator;
  private config: BotConfig;

  constructor(config: BotConfig, evaluator: Evaluator) {
    this.config = config;
    this.evaluator = evaluator;
  }

  search(state: GameState, legalActions: Action[]): Action {
    if (legalActions.length === 0) {
      return { type: 'move', moveIndex: 1 };
    }

    if (legalActions.length === 1) {
      return legalActions[0];
    }

    const actionScores = new Map<string, number>();
    
    for (const action of legalActions) {
      let score = 0;
      
      if (action.type === 'move') {
        const myActive = state.myTeam[state.myActive];
        const oppActive = state.opponentTeam[state.opponentActive];
        
        if (myActive && oppActive) {
          const moves = Array.from(myActive.revealedMoves);
          const moveIndex = action.moveIndex - 1;
          const move = moves[moveIndex] || 'Tackle';
          
          const damage = simulator.estimateDamage(myActive, oppActive, move);
          score += damage / 10;
        } else {
          score += 5;
        }
      } else {
        score = 2;
      }

      const oppAction = this.sampleOpponentAction(state);
      const result = simulator.simulateAction(state, action, oppAction);
      
      if (result.terminated) {
        score += result.winner === 'p1' ? 100 : -100;
      } else {
        score += this.evaluator.evaluate(result.state).score / 10;
      }

      actionScores.set(this.actionKey(action), score);
    }

    let bestAction = legalActions[0];
    let bestScore = -Infinity;

    for (const action of legalActions) {
      const score = actionScores.get(this.actionKey(action)) || 0;
      
      if (score > bestScore) {
        bestScore = score;
        bestAction = action;
      }
    }

    return bestAction;
  }

  private sampleOpponentAction(state: GameState): Action {
    const hasSwitch = state.opponentTeam.length > 1;
    if (hasSwitch && Math.random() < 0.2) {
      return { type: 'switch', switchIndex: 2 };
    }
    return { type: 'move', moveIndex: Math.floor(Math.random() * 4) + 1 };
  }

  private actionKey(action: Action): string {
    return JSON.stringify(action);
  }

  getSearchStats() {
    return {
      nodes: 0,
      topActions: [],
    };
  }
}
