import { Action, GameState, BotConfig } from '../types/index.js';
import { Evaluator } from './evaluator.js';
import { Format } from '../types/format.js';
import { WorldBuilder } from './world-builder.js';
import { simulator } from './simulator.js';

interface SearchResult {
  action: Action;
  value: number;
  visits: number;
}

/**
 * Improved determinized search with proper lookahead.
 * 
 * Algorithm:
 * 1. Build N determinized worlds by sampling opponent sets
 * 2. For each world, expand 2-3 ply using expectiminimax
 * 3. Weight opponent moves by behavioral model
 * 4. Aggregate results across worlds
 * 5. Select action with best expected value
 */
export class ImprovedSearch {
  private config: BotConfig;
  private evaluator: Evaluator;
  private format: Format;
  private worldBuilder: WorldBuilder;
  
  constructor(config: BotConfig, evaluator: Evaluator, format: Format) {
    this.config = config;
    this.evaluator = evaluator;
    this.format = format;
    this.worldBuilder = new WorldBuilder(format);
  }
  
  search(state: GameState, legalActions: Action[]): Action {
    if (legalActions.length === 0) {
      return { type: 'move', moveIndex: 1 };
    }
    
    if (legalActions.length === 1) {
      return legalActions[0];
    }
    
    const startTime = Date.now();
    const timeLimit = this.config.searchTimeMs;
    
    // Build determinized worlds
    const numWorlds = this.config.sampledWorlds || 3;
    const worlds = this.worldBuilder.buildWorlds(state, numWorlds);
    
    // Search in each world
    const actionValues = new Map<string, number[]>();
    
    for (const action of legalActions) {
      actionValues.set(this.actionKey(action), []);
    }
    
    for (const world of worlds) {
      if (Date.now() - startTime > timeLimit) {
        break;
      }
      
      const worldResults = this.searchInWorld(world, legalActions, 2);
      
      for (const [actionKey, value] of worldResults) {
        actionValues.get(actionKey)!.push(value);
      }
    }
    
    // Aggregate: mean value across worlds
    let bestAction = legalActions[0];
    let bestValue = -Infinity;
    
    for (const action of legalActions) {
      const values = actionValues.get(this.actionKey(action))!;
      if (values.length === 0) continue;
      
      const meanValue = values.reduce((a, b) => a + b, 0) / values.length;
      
      if (meanValue > bestValue) {
        bestValue = meanValue;
        bestAction = action;
      }
    }
    
    return bestAction;
  }
  
  /**
   * Search in one determinized world using expectiminimax.
   */
  private searchInWorld(
    state: GameState,
    legalActions: Action[],
    depth: number
  ): Map<string, number> {
    const results = new Map<string, number>();
    
    for (const myAction of legalActions) {
      const value = this.expectiminimax(state, myAction, depth, true);
      results.set(this.actionKey(myAction), value);
    }
    
    return results;
  }
  
  /**
   * Expectiminimax: maximize over our actions, expectation over opponent's.
   */
  private expectiminimax(
    state: GameState,
    myAction: Action,
    depth: number,
    isMaxNode: boolean
  ): number {
    if (depth === 0) {
      return this.evaluate(state);
    }
    
    // Sample opponent actions with behavioral weighting
    const oppActions = this.sampleOpponentActions(state, 3);
    
    let totalValue = 0;
    let totalWeight = 0;
    
    for (const oppAction of oppActions) {
      // Simulate one turn
      const result = simulator.simulateAction(state, myAction, oppAction.action);
      
      if (result.terminated) {
        const value = result.winner === 'p1' ? 10000 : -10000;
        totalValue += value * oppAction.weight;
        totalWeight += oppAction.weight;
      } else {
        // Recurse
        const futureValue = depth > 1 
          ? this.bestResponse(result.state, depth - 1)
          : this.evaluate(result.state);
        
        totalValue += futureValue * oppAction.weight;
        totalWeight += oppAction.weight;
      }
    }
    
    return totalWeight > 0 ? totalValue / totalWeight : 0;
  }
  
  /**
   * Find best response from a position (our turn to choose).
   */
  private bestResponse(state: GameState, depth: number): number {
    const myActive = state.myTeam[state.myActive];
    if (!myActive || myActive.species === 'Unknown') {
      return this.evaluate(state);
    }
    
    // Quick actions: attack with first move or second
    const quickActions: Action[] = [
      { type: 'move', moveIndex: 1 },
      { type: 'move', moveIndex: 2 },
    ];
    
    let bestValue = -Infinity;
    for (const action of quickActions) {
      const value = this.expectiminimax(state, action, depth - 1, true);
      if (value > bestValue) {
        bestValue = value;
      }
    }
    
    return bestValue;
  }
  
  /**
   * Sample opponent actions weighted by behavioral model.
   */
  private sampleOpponentActions(
    state: GameState,
    count: number
  ): Array<{ action: Action; weight: number }> {
    const actions: Array<{ action: Action; weight: number }> = [];
    
    const oppActive = state.opponentTeam[state.opponentActive];
    if (!oppActive || oppActive.species === 'Unknown') {
      return [{ action: { type: 'move', moveIndex: 1 }, weight: 1.0 }];
    }
    
    // Get situation
    const situation = this.assessSituation(state);
    const behavior = this.format.predictBehavior(oppActive, situation);
    
    // Sample moves
    const oppMoves = oppActive.revealedMoves instanceof Set
      ? Array.from(oppActive.revealedMoves)
      : Array.isArray(oppActive.revealedMoves)
      ? oppActive.revealedMoves
      : [];
    
    const moves = oppMoves.slice(0, Math.min(count, 4));
    const moveWeight = behavior.attackProb / Math.max(moves.length, 1);
    
    for (let i = 0; i < moves.length; i++) {
      actions.push({
        action: { type: 'move', moveIndex: i + 1 },
        weight: moveWeight,
      });
    }
    
    // Sample switch
    const oppAlive = state.opponentTeam.filter(m => m.species !== 'Unknown').length;
    if (oppAlive > 1 && behavior.switchProb > 0.1) {
      actions.push({
        action: { type: 'switch', switchIndex: 2 },
        weight: behavior.switchProb,
      });
    }
    
    return actions.slice(0, count);
  }
  
  private assessSituation(state: GameState): 'advantage' | 'neutral' | 'disadvantage' {
    const myActive = state.myTeam[state.myActive];
    const oppActive = state.opponentTeam[state.opponentActive];
    
    if (!myActive || !oppActive || oppActive.species === 'Unknown') {
      return 'neutral';
    }
    
    // Simple type-based assessment
    let myDamage = 0;
    let oppDamage = 0;
    
    // Ensure revealedMoves is iterable
    const myMoves = myActive.revealedMoves instanceof Set 
      ? Array.from(myActive.revealedMoves)
      : Array.isArray(myActive.revealedMoves)
      ? myActive.revealedMoves
      : [];
    
    for (const move of myMoves) {
      const dmg = simulator.estimateDamage(myActive, oppActive, String(move));
      myDamage = Math.max(myDamage, dmg);
    }
    
    const oppMoves = oppActive.revealedMoves instanceof Set
      ? Array.from(oppActive.revealedMoves)
      : Array.isArray(oppActive.revealedMoves)
      ? oppActive.revealedMoves
      : [];
    
    for (const move of oppMoves) {
      const dmg = simulator.estimateDamage(oppActive, myActive, String(move));
      oppDamage = Math.max(oppDamage, dmg);
    }
    
    if (myDamage > oppDamage * 1.5) {
      return 'advantage';
    } else if (oppDamage > myDamage * 1.5) {
      return 'disadvantage';
    }
    
    return 'neutral';
  }
  
  private evaluate(state: GameState): number {
    const evalResult = this.evaluator.evaluate(state);
    return evalResult.score;
  }
  
  private actionKey(action: Action): string {
    return JSON.stringify(action);
  }
}
