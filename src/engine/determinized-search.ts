import { Action, GameState, BotConfig } from '../types/index.js';
import { Evaluator } from './evaluator.js';
import { simulator } from './simulator.js';
import { opponentModel } from './opponent-model.js';

interface WorldResult {
  action: Action;
  value: number;
  visits: number;
}

export class DeterminizedSearch {
  private config: BotConfig;
  private evaluator: Evaluator;

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

    const startTime = Date.now();
    const actionScores = new Map<string, number[]>();

    for (const action of legalActions) {
      actionScores.set(this.actionKey(action), []);
    }

    const numWorlds = Math.min(this.config.sampledWorlds, 5);
    
    for (let world = 0; world < numWorlds; world++) {
      if (Date.now() - startTime > this.config.searchTimeMs) break;

      const worldResults = this.searchInWorld(state, legalActions);
      
      for (const [actionKey, value] of worldResults) {
        const scores = actionScores.get(actionKey);
        if (scores) {
          scores.push(value);
        }
      }
    }

    let bestAction = legalActions[0];
    let bestAvgScore = -Infinity;

    for (const action of legalActions) {
      const scores = actionScores.get(this.actionKey(action)) || [];
      const avgScore = scores.length > 0 
        ? scores.reduce((a, b) => a + b, 0) / scores.length 
        : 0;
      
      if (avgScore > bestAvgScore) {
        bestAvgScore = avgScore;
        bestAction = action;
      }
    }

    return bestAction;
  }

  private searchInWorld(
    state: GameState,
    legalActions: Action[]
  ): Map<string, number> {
    const results = new Map<string, number>();

    for (const myAction of legalActions) {
      const value = this.evaluateActionWithLookahead(state, myAction, 2);
      results.set(this.actionKey(myAction), value);
    }

    return results;
  }

  private evaluateActionWithLookahead(
    state: GameState,
    myAction: Action,
    depth: number
  ): number {
    if (depth === 0) {
      return this.evaluatePosition(state);
    }

    const myActive = state.myTeam[state.myActive];
    const oppActive = state.opponentTeam[state.opponentActive];

    if (!myActive || !oppActive) {
      return 0;
    }

    let totalValue = 0;
    let samples = 0;

    const oppActions = this.sampleOpponentActions(state, 3);

    for (const oppAction of oppActions) {
      const result = simulator.simulateAction(state, myAction, oppAction);
      
      if (result.terminated) {
        totalValue += result.winner === 'p1' ? 1000 : -1000;
        samples++;
      } else {
        const posValue = this.evaluatePosition(result.state);
        const futureValue = depth > 1 ? this.evaluateBestResponse(result.state, depth - 1) : 0;
        totalValue += posValue + futureValue * 0.5;
        samples++;
      }
    }

    return samples > 0 ? totalValue / samples : 0;
  }

  private evaluateBestResponse(state: GameState, depth: number): number {
    const myActive = state.myTeam[state.myActive];
    if (!myActive || myActive.revealedMoves.size === 0) {
      return 0;
    }

    const quickActions: Action[] = [
      { type: 'move', moveIndex: 1 },
      { type: 'move', moveIndex: 2 },
    ];

    let bestValue = -Infinity;
    for (const action of quickActions) {
      const value = this.evaluateActionWithLookahead(state, action, depth - 1);
      if (value > bestValue) {
        bestValue = value;
      }
    }

    return bestValue;
  }

  private sampleOpponentActions(state: GameState, count: number): Action[] {
    const actions: Action[] = [];
    
    const oppActive = state.opponentTeam[state.opponentActive];
    if (!oppActive || oppActive.species === 'Unknown') {
      return [{ type: 'move', moveIndex: 1 }];
    }

    const candidates = opponentModel.getPossibleSets(oppActive);
    const moveDist = opponentModel.predictMoveDistribution(oppActive);
    
    const sortedMoves = Array.from(moveDist.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.min(count, 4));

    for (let i = 0; i < sortedMoves.length; i++) {
      actions.push({ type: 'move', moveIndex: i + 1 });
    }

    const hasSwitch = state.opponentTeam.filter(m => m.species !== 'Unknown').length > 1;
    const myActive = state.myTeam[state.myActive];
    
    let situation: 'advantage' | 'neutral' | 'disadvantage' = 'neutral';
    if (myActive && oppActive.species !== 'Unknown') {
      const myDamage = this.estimateTypeDamage(myActive, oppActive);
      const oppDamage = this.estimateTypeDamage(oppActive, myActive);
      if (myDamage > oppDamage * 1.5) situation = 'disadvantage';
      else if (oppDamage > myDamage * 1.5) situation = 'advantage';
    }
    
    const behavior = opponentModel.predictBehavior(oppActive, situation);
    
    if (hasSwitch && Math.random() < behavior.switchProb) {
      actions.push({ type: 'switch', switchIndex: 2 });
    }

    return actions.slice(0, count);
  }

  private estimateTypeDamage(attacker: any, defender: any): number {
    if (!attacker.revealedMoves || attacker.revealedMoves.size === 0) {
      return 80;
    }
    
    let maxDamage = 0;
    for (const move of attacker.revealedMoves) {
      const damage = simulator.estimateDamage(attacker, defender, move);
      maxDamage = Math.max(maxDamage, damage);
    }
    return maxDamage;
  }

  private evaluatePosition(state: GameState): number {
    const myActive = state.myTeam[state.myActive];
    const oppActive = state.opponentTeam[state.opponentActive];

    if (!myActive || !oppActive) {
      return 0;
    }

    let score = 0;

    const myAlive = state.myTeam.filter(m => m.species !== 'Unknown').length;
    const oppAlive = state.opponentTeam.filter(m => m.species !== 'Unknown').length;
    score += (myAlive - oppAlive) * 100;

    if (myActive.revealedMoves.size > 0 && oppActive.species !== 'Unknown') {
      for (const move of myActive.revealedMoves) {
        const damage = simulator.estimateDamage(myActive, oppActive, move);
        score = Math.max(score, damage / 2);
      }
    }

    const evalResult = this.evaluator.evaluate(state);
    score += evalResult.score;

    return score;
  }

  private actionKey(action: Action): string {
    return JSON.stringify(action);
  }
}
