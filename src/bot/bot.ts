import { Action, GameState, BotConfig, BattleRecord, DecisionRecord } from '../types/index.js';
import { Format } from '../types/format.js';
import { BeliefTracker } from '../engine/belief-tracker.js';
import { RobustSearch } from '../engine/robust-search.js';
import { Evaluator } from '../engine/evaluator.js';
import { BattleLogger } from '../learning/battle-logger.js';
import { dataLoader } from '../data/data-loader.js';

export class Bot {
  private config: BotConfig;
  private format: Format;
  private evaluator: Evaluator;
  private beliefTracker: BeliefTracker;
  private logger: BattleLogger;
  private searchEngine: RobustSearch;
  private currentBattle?: {
    id: string;
    startTime: number;
    decisions: DecisionRecord[];
    log: string[];
  };

  constructor(config: BotConfig, format: Format, logger: BattleLogger) {
    this.config = config;
    this.format = format;
    this.evaluator = new Evaluator(format.getEvaluatorWeights());
    this.beliefTracker = new BeliefTracker();
    this.logger = logger;
    this.searchEngine = new RobustSearch(config, this.evaluator, format);
  }

  async initialize(): Promise<void> {
    await dataLoader.load(this.format);
  }

  startBattle(battleId: string): void {
    this.currentBattle = {
      id: battleId,
      startTime: Date.now(),
      decisions: [],
      log: [],
    };
    this.beliefTracker = new BeliefTracker();
  }

  async selectAction(state: GameState, legalActions: Action[]): Promise<Action> {
    if (legalActions.length === 0) {
      return { type: 'move', moveIndex: 1 };
    }

    if (legalActions.length === 1) {
      return legalActions[0];
    }

    try {
      const startTime = Date.now();
      const action = await this.searchEngine.search(state, legalActions);
      const timeMs = Date.now() - startTime;

      if (this.currentBattle) {
        const evaluation = this.evaluator.evaluate(state);
        this.currentBattle.decisions.push({
          turn: state.turn,
          state: JSON.stringify(state),
          action,
          searchStats: {
            nodes: 0,
            timeMs,
            topActions: [],
          },
          evaluation,
        });
      }

      return action;
    } catch (e) {
      console.error('Error in selectAction:', e);
      return legalActions[0];
    }
  }
  
  /**
   * Reconcile tracked state with server's request.
   * Logs any mismatches for debugging.
   */
  reconcileState(trackedState: GameState, request: any): void {
    const mismatches = this.format.reconcileState(trackedState, request);
    
    if (mismatches.length > 0) {
      console.warn(`[Bot] State mismatches detected (turn ${trackedState.turn}):`);
      for (const mismatch of mismatches) {
        const prefix = mismatch.severity === 'error' ? '❌' : 
                      mismatch.severity === 'warning' ? '⚠️' : 'ℹ️';
        console.warn(`  ${prefix} ${mismatch.field}: tracked=${mismatch.tracked}, actual=${mismatch.actual}`);
      }
      
      if (this.currentBattle) {
        this.currentBattle.log.push(`State mismatches: ${JSON.stringify(mismatches)}`);
      }
    }
  }

  updateBelief(pokemonId: string, species: string, level: number): void {
    this.beliefTracker.initializeBelief(pokemonId, species, level);
  }

  updateBeliefOnMove(pokemonId: string, move: string): void {
    this.beliefTracker.updateOnMove(pokemonId, move);
  }

  updateBeliefOnItem(pokemonId: string, item: string): void {
    this.beliefTracker.updateOnItem(pokemonId, item);
  }

  updateBeliefOnAbility(pokemonId: string, ability: string): void {
    this.beliefTracker.updateOnAbility(pokemonId, ability);
  }

  logBattleMessage(message: string): void {
    if (this.currentBattle) {
      this.currentBattle.log.push(message);
    }
  }

  endBattle(outcome: 'win' | 'loss' | 'tie', opponent: string, turns: number): void {
    if (!this.currentBattle) return;

    const record: BattleRecord = {
      id: this.currentBattle.id,
      timestamp: this.currentBattle.startTime,
      outcome,
      turns,
      opponent,
      log: this.currentBattle.log.join('\n'),
      decisions: this.currentBattle.decisions,
    };

    this.logger.logBattle(record);
    this.currentBattle = undefined;
  }

  getConfig(): BotConfig {
    return { ...this.config };
  }
  
  getFallbackStats(): { fallbackCount: number; totalCalls: number; fallbackRate: number } {
    return this.searchEngine.getFallbackStats();
  }
  
  resetFallbackStats(): void {
    this.searchEngine.resetFallbackStats();
  }
}
