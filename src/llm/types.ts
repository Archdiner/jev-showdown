import type { Action, GameState } from '../types/index.js';

export type BlendMode = 'off' | 'prior' | 'tiebreaker' | 'veto-blunders';

export interface BlendConfig {
  /** Default is off. Champion stays off; a gate challenger opts in. */
  mode: BlendMode;
  /** Weight on the advisor score when mode is `prior`. Search keeps `1 - priorWeight`. */
  priorWeight: number;
  /** Search-score gap that still counts as a tie when mode is `tiebreaker`. */
  tieEpsilon: number;
  /** How many leading search actions are sent to the advisor. */
  topK: number;
  /** Advisor score at or below this is vetoed when mode is `veto-blunders`. */
  blunderThreshold?: number;
}

export const DEFAULT_BLEND_CONFIG: BlendConfig = {
  mode: 'off',
  priorWeight: 0.15,
  tieEpsilon: 0.05,
  topK: 8,
};

export interface ScoredAction {
  action: Action;
  searchScore: number;
}

/**
 * What the LLM layer needs from search. Search engines implement this;
 * this package does not call into search internals.
 */
export interface CandidateSearch {
  scoreActions(state: GameState, legalActions: Action[]): Promise<ScoredAction[]>;
}

export interface CompactPokemon {
  species: string;
  hpPercent: number | null;
  status?: string;
  revealedMoves: string[];
  ability?: string;
  item?: string;
  teraType?: string;
}

export interface CompactStateSummary {
  turn: number;
  player: 'p1' | 'p2' | 'unknown';
  field: GameState['field'];
  hazards: GameState['hazards'];
  myActive: CompactPokemon | null;
  opponentActive: CompactPokemon | null;
  myBench: CompactPokemon[];
  opponentBench: CompactPokemon[];
  teraUsed: { mine: boolean; opponent: boolean };
}

export interface AdvisorCandidate {
  id: string;
  label: string;
  action: Action;
  searchScore: number;
}

export interface AdvisorAssessment {
  model: string;
  scores: Record<string, number>;
  probabilities: Record<string, number>;
  /** Boolean question name -> probability the answer is true. */
  booleans: Record<string, number>;
  degraded: boolean;
  reason?: string;
  latencyMs: number;
  costUsd: number;
}

export interface RankedCandidate {
  id: string;
  action: Action;
  searchScore: number;
  advisorScore: number | null;
  advisorProbability: number | null;
  blendedScore: number;
}

export interface BlendOutcome {
  action: Action;
  ranked: RankedCandidate[];
  source: 'search' | 'prior' | 'tiebreaker' | 'veto-blunders';
  degraded: boolean;
}
