import { Action, GameState, BotConfig } from '../types/index.js';
import { Evaluator } from './evaluator.js';
import { Format } from '../types/format.js';
import { SimWrapper } from './sim-wrapper.js';

/**
 * Robust 2-3 ply search with determinization.
 * Simpler implementation focusing on correctness over sophistication.
 */
export class RobustSearch {
  private config: BotConfig;
  private evaluator: Evaluator;
  private format: Format;
  private simWrapper: SimWrapper;
  
  constructor(config: BotConfig, evaluator: Evaluator, format: Format) {
    this.config = config;
    this.evaluator = evaluator;
    this.format = format;
    this.simWrapper = new SimWrapper(format);
  }
  
  getFallbackStats(): { fallbackCount: number; totalCalls: number; fallbackRate: number } {
    return this.simWrapper.getFallbackStats();
  }
  
  resetFallbackStats(): void {
    this.simWrapper.resetStats();
  }
  
  async search(state: GameState, legalActions: Action[]): Promise<Action> {
    if (legalActions.length === 0) {
      return { type: 'move', moveIndex: 1 };
    }
    
    if (legalActions.length === 1) {
      return legalActions[0];
    }
    
    const startTime = Date.now();
    
    // Build multiple determinized worlds
    const numWorlds = Math.min(this.config.sampledWorlds || 3, 5);
    const worlds: GameState[] = [];
    
    for (let i = 0; i < numWorlds; i++) {
      worlds.push(this.cloneState(state));
    }
    
    // Evaluate each action across worlds
    const actionScores = new Map<string, number[]>();
    
    for (const action of legalActions) {
      const scores: number[] = [];
      
      for (const world of worlds) {
        if (Date.now() - startTime > this.config.searchTimeMs) {
          break;
        }
        
        // Use 3-ply search for better lookahead
        const score = await this.evaluateAction(world, action, 3);
        scores.push(score);
      }
      
      actionScores.set(this.actionKey(action), scores);
    }
    
    // Select action with best mean score
    let bestAction = legalActions[0];
    let bestScore = -Infinity;
    
    for (const action of legalActions) {
      const scores = actionScores.get(this.actionKey(action)) || [];
      if (scores.length === 0) continue;
      
      const meanScore = scores.reduce((a, b) => a + b, 0) / scores.length;
      
      if (meanScore > bestScore) {
        bestScore = meanScore;
        bestAction = action;
      }
    }
    
    return bestAction;
  }
  
  /**
   * Evaluate an action with N-ply lookahead.
   */
  private async evaluateAction(state: GameState, myAction: Action, depth: number): Promise<number> {
    if (depth === 0) {
      return this.evaluator.evaluate(state).score;
    }
    
    // Sample opponent responses (more samples for better accuracy)
    const oppActions = await this.sampleOpponentActions(state, 4);
    
    if (oppActions.length === 0) {
      return this.evaluator.evaluate(state).score;
    }
    
    let totalValue = 0;
    let totalWeight = 0;
    
    for (const oppAction of oppActions) {
      // Simulate the turn with real sim mechanics
      const result = await this.simWrapper.simulateTurn(state, myAction, oppAction.action);
      
      if (result.terminated) {
        const value = result.winner === 'p1' ? 10000 : -10000;
        totalValue += value * oppAction.weight;
        totalWeight += oppAction.weight;
      } else {
        // Recursively evaluate
        const futureValue = depth > 1
          ? await this.evaluateBestResponse(result.state, depth - 1)
          : this.evaluator.evaluate(result.state).score;
        
        totalValue += futureValue * oppAction.weight;
        totalWeight += oppAction.weight;
      }
    }
    
    return totalWeight > 0 ? totalValue / totalWeight : 0;
  }
  
  /**
   * Find best response from our perspective.
   */
  private async evaluateBestResponse(state: GameState, depth: number): Promise<number> {
    const myActive = state.myTeam[state.myActive];
    
    if (!myActive || myActive.species === 'Unknown') {
      return this.evaluator.evaluate(state).score;
    }
    
    // Sample more actions for better response
    const moves = this.getMoveArray(myActive.revealedMoves);
    const quickActions: Action[] = [];
    
    for (let i = 0; i < Math.min(3, moves.length); i++) {
      quickActions.push({ type: 'move', moveIndex: i + 1 });
    }
    
    if (quickActions.length === 0) {
      quickActions.push({ type: 'move', moveIndex: 1 });
    }
    
    let bestValue = -Infinity;
    
    for (const action of quickActions) {
      const value = await this.evaluateAction(state, action, depth - 1);
      if (value > bestValue) {
        bestValue = value;
      }
    }
    
    return bestValue;
  }
  
  /**
   * Sample opponent actions with weights from behavioral model.
   */
  private async sampleOpponentActions(state: GameState, count: number): Promise<Array<{ action: Action; weight: number }>> {
    const actions: Array<{ action: Action; weight: number }> = [];
    
    const oppActive = state.opponentTeam[state.opponentActive];
    
    if (!oppActive || oppActive.species === 'Unknown') {
      return [{ action: { type: 'move', moveIndex: 1 }, weight: 1.0 }];
    }
    
    // Get behavioral prediction  
    const situation = await this.assessSituation(state);
    const behavior = this.format.predictBehavior(oppActive, situation);
    
    // Sample moves
    const oppMoves = this.getMoveArray(oppActive.revealedMoves);
    const numMoves = Math.min(oppMoves.length, count);
    
    if (numMoves > 0) {
      const moveWeight = behavior.attackProb / numMoves;
      
      for (let i = 0; i < numMoves; i++) {
        actions.push({
          action: { type: 'move', moveIndex: i + 1 },
          weight: moveWeight,
        });
      }
    }
    
    // Sample switch
    const oppAlive = state.opponentTeam.filter(m => m.species !== 'Unknown').length;
    if (oppAlive > 1 && behavior.switchProb > 0.1) {
      actions.push({
        action: { type: 'switch', switchIndex: 2 },
        weight: behavior.switchProb,
      });
    }
    
    // Fallback
    if (actions.length === 0) {
      actions.push({ action: { type: 'move', moveIndex: 1 }, weight: 1.0 });
    }
    
    return actions;
  }
  
  private async assessSituation(state: GameState): Promise<'advantage' | 'neutral' | 'disadvantage'> {
    const myActive = state.myTeam[state.myActive];
    const oppActive = state.opponentTeam[state.opponentActive];
    
    if (!myActive || !oppActive || oppActive.species === 'Unknown') {
      return 'neutral';
    }
    
    const myMoves = this.getMoveArray(myActive.revealedMoves);
    const oppMoves = this.getMoveArray(oppActive.revealedMoves);
    
    let myDamage = 0;
    let oppDamage = 0;
    
    // Use simWrapper for damage estimation
    const { Dex } = await import('@pkmn/sim');
    
    for (const move of myMoves) {
      const moveData = Dex.moves.get(move);
      if (moveData && moveData.basePower) {
        const isPhysical = moveData.category === 'Physical';
        const attackStat = isPhysical ? (myActive.stats?.atk || 100) : (myActive.stats?.spa || 100);
        const defenseStat = isPhysical ? (oppActive.stats?.def || 100) : (oppActive.stats?.spd || 100);
        const baseDmg = (attackStat / defenseStat) * moveData.basePower;
        myDamage = Math.max(myDamage, baseDmg);
      }
    }
    
    for (const move of oppMoves) {
      const moveData = Dex.moves.get(move);
      if (moveData && moveData.basePower) {
        const isPhysical = moveData.category === 'Physical';
        const attackStat = isPhysical ? (oppActive.stats?.atk || 100) : (oppActive.stats?.spa || 100);
        const defenseStat = isPhysical ? (myActive.stats?.def || 100) : (myActive.stats?.spd || 100);
        const baseDmg = (attackStat / defenseStat) * moveData.basePower;
        oppDamage = Math.max(oppDamage, baseDmg);
      }
    }
    
    if (myDamage > oppDamage * 1.5) {
      return 'advantage';
    } else if (oppDamage > myDamage * 1.5) {
      return 'disadvantage';
    }
    
    return 'neutral';
  }
  
  private getMoveArray(moves: Set<string> | any): string[] {
    if (moves instanceof Set) {
      return Array.from(moves);
    } else if (Array.isArray(moves)) {
      return moves;
    } else if (moves && typeof moves === 'object') {
      return Object.keys(moves);
    }
    return [];
  }
  
  private cloneState(state: GameState): GameState {
    return {
      ...state,
      myTeam: state.myTeam.map(mon => ({
        ...mon,
        revealedMoves: new Set(this.getMoveArray(mon.revealedMoves)),
        possibleSets: new Map(mon.possibleSets),
      })),
      opponentTeam: state.opponentTeam.map(mon => ({
        ...mon,
        revealedMoves: new Set(this.getMoveArray(mon.revealedMoves)),
        possibleSets: new Map(mon.possibleSets),
      })),
      field: { ...state.field, screens: { ...state.field.screens } },
      hazards: {
        my: { ...state.hazards.my },
        opponent: { ...state.hazards.opponent },
      },
    };
  }
  
  private actionKey(action: Action): string {
    return JSON.stringify(action);
  }
}
