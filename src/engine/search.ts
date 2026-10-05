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

    const actionScores = new Map<string, { total: number; samples: number }>();
    
    for (const action of legalActions) {
      actionScores.set(this.actionKey(action), { total: 0, samples: 0 });
    }

    const startTime = Date.now();
    let iterations = 0;

    while (
      Date.now() - startTime < this.config.searchTimeMs &&
      iterations < this.config.searchIterations
    ) {
      for (const action of legalActions) {
        const score = this.evaluateAction(state, action);
        const scores = actionScores.get(this.actionKey(action))!;
        scores.total += score;
        scores.samples++;
      }
      iterations++;
    }

    let bestAction = legalActions[0];
    let bestAvgScore = -Infinity;

    for (const action of legalActions) {
      const scores = actionScores.get(this.actionKey(action))!;
      const avgScore = scores.samples > 0 ? scores.total / scores.samples : 0;
      
      if (avgScore > bestAvgScore) {
        bestAvgScore = avgScore;
        bestAction = action;
      }
    }

    return bestAction;
  }

  private evaluateAction(state: GameState, action: Action): number {
    let score = 0;

    if (action.type === 'move') {
      const myActive = state.myTeam[state.myActive];
      const oppActive = state.opponentTeam[state.opponentActive];
      
      if (myActive && oppActive) {
        const moves = Array.from(myActive.revealedMoves);
        const moveIndex = action.moveIndex - 1;
        const move = moves[moveIndex] || 'Tackle';
        
        const damage = simulator.estimateDamage(myActive, oppActive, move);
        score += damage / 5;

        const effectiveness = simulator.estimateDamage(myActive, oppActive, move) / 100;
        if (effectiveness > 1.5) {
          score += 10;
        } else if (effectiveness < 0.75) {
          score -= 5;
        }
      } else {
        score += 10;
      }
    } else {
      const myActive = state.myTeam[action.switchIndex - 1];
      if (myActive) {
        score += 5;
      }
    }

    const oppAction = this.sampleOpponentAction(state);
    const result = simulator.simulateAction(state, action, oppAction);
    
    if (result.terminated) {
      score += result.winner === 'p1' ? 200 : -200;
    } else {
      const evalScore = this.evaluator.evaluate(result.state).score;
      score += evalScore / 5;
    }

    return score;
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
