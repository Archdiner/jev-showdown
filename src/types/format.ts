import { Action, GameState, PokemonBelief, EvaluatorWeights } from './index.js';

/**
 * Format-specific configuration and behavior.
 * Allows the bot to support different battle formats without changing
 * core search, client, logger, or learning infrastructure.
 */
export interface Format {
  /** Format ID (e.g., 'gen9randombattle', 'gen9ou') */
  readonly id: string;
  
  /** Display name */
  readonly name: string;
  
  /** Data sources for this format */
  dataSources: {
    /** URL to official sets/pools */
    setsUrl: string;
    /** URL to statistics (role probabilities, move frequencies) */
    statsUrl?: string;
    /** URL to format rules/config */
    rulesUrl?: string;
  };
  
  /**
   * Initialize format-specific data.
   * Called once on startup after freshness check.
   */
  initialize(data: { sets: any; stats: any }): Promise<void>;
  
  /**
   * Get possible sets for a species, narrowed by revealed information.
   * Used for opponent modeling and determinization.
   */
  getPossibleSets(pokemon: PokemonBelief): SetCandidate[];
  
  /**
   * Sample one consistent set from the belief distribution.
   * Used to build determinized worlds.
   */
  sampleSet(pokemon: PokemonBelief): SetCandidate | null;
  
  /**
   * Calculate exact stats for a species at a given level.
   * Format-specific (randbats uses 85 EVs, 31 IVs, neutral nature).
   */
  calculateStats(species: string, level: number): PokemonStats | null;
  
  /**
   * Get legal actions for the current game state.
   * Handles format-specific rules (team preview, trapping, etc.)
   */
  getLegalActions(request: any): Action[];
  
  /**
   * Get format-specific evaluation weights.
   * Different formats value material, hazards, etc. differently.
   */
  getEvaluatorWeights(): EvaluatorWeights;
  
  /**
   * Predict opponent behavior based on situation.
   * Returns probabilities for attack/switch/tera.
   */
  predictBehavior(
    pokemon: PokemonBelief,
    situation: 'advantage' | 'neutral' | 'disadvantage'
  ): BehaviorPrediction;
  
  /**
   * Build a GameState from a battle request.
   * Format-specific parsing of team/field data.
   */
  buildGameState(request: any, opponentTracking: OpponentTracking): GameState;
  
  /**
   * Reconcile tracked state with server's request JSON.
   * Returns mismatches for logging.
   */
  reconcileState(tracked: GameState, request: any): StateMismatch[];
}

export interface SetCandidate {
  role: string;
  moves: string[];
  item?: string;
  ability?: string;
  teraType?: string;
  probability: number;
}

export interface PokemonStats {
  hp: number;
  atk: number;
  def: number;
  spa: number;
  spd: number;
  spe: number;
}

export interface BehaviorPrediction {
  attackProb: number;
  switchProb: number;
  teraProb: number;
}

export interface OpponentTracking {
  team: Map<string, any>;
  activeSpecies: string | null;
  revealedMoves: Map<string, Set<string>>;
  revealedItems: Map<string, string>;
  revealedAbilities: Map<string, string>;
}

export interface StateMismatch {
  field: string;
  tracked: any;
  actual: any;
  severity: 'info' | 'warning' | 'error';
}
