import type { Battle, PRNG } from '@pkmn/sim';
import type { SideId } from '../engine/exact/battle-utils.js';
import type { EnvName, EnvProfile } from './env.js';
import type { ResolvedConfig } from './schema.js';
import type { MacroStyle } from './schema.js';

/**
 * Plug-in points for the other branches.
 *
 * Search (main): keep `exactSearch`. Register a new search id; do not add an entry point.
 * Live client (`cursor/live-client`): implement `LiveBattleBridge` and pass it to the ladder session.
 * LLM (`cursor/llm-layer`, merged): `JevAdvisor`, `GatewayClient`, `LossReviewer`, `buildBattleFacts`.
 */

export interface GamePlan {
  style: MacroStyle;
  /** Species on this team chosen by a stat rule, not by a config special case. */
  winCondition: string;
  preserve: string[];
  notes: string;
}

export interface LayerIds {
  agent: string;
  search: string;
  evaluator: string;
  setInference: string;
  behavior: string;
  teraPolicy: string;
  hazardPolicy: string;
  sacPolicy: string;
  switchPolicy: string;
  leadPolicy: string;
  endgamePolicy: string;
  context: string;
  advisor: string;
  models: string;
  metaController: string;
}

export interface PolicyEffect {
  override?: string;
  bias?: Record<string, number>;
}

export interface LiveBattleInput {
  room: string;
  log: string;
  request: unknown;
  side: SideId;
}

/** cursor/live-client implements this. Returning null means the turn cannot be decided. */
export interface LiveBattleBridge {
  reconstruct(input: LiveBattleInput): Battle | null;
}

export interface DecisionInput {
  battle: Battle;
  side: SideId;
  rng?: PRNG;
  gameId?: string;
  seed?: number;
  rating?: number;
  /** Arm drawn for this live game. Search and advisors may read it; they do not have to. */
  variantId?: string;
  /** Showdown seconds left on our clock, when the battle sent one. */
  secondsLeft?: number | null;
}

export interface AttributedDecision {
  choice: string;
  configId: string;
  layerIds: LayerIds;
  activeLayerIds: LayerIds;
  scores: Array<{ choice: string; score: number }>;
  ms: number;
  advisorCalled: boolean;
  advisorSource?: string;
  overBudget: boolean;
  gamePlan: GamePlan | null;
  predictedSwitch?: boolean;
  answersPredictedSwitch?: boolean;
  variantId?: string;
}

export interface BotSpec {
  configId: string;
  config: ResolvedConfig;
  env: EnvName;
  /**
   * Optional extra cap from an experiment spec. It can only lower the env
   * profile's cap. It cannot turn LLM calls on.
   */
  llmCostCapUsd?: number;
}

export interface RuntimeCaps {
  timeLimitMs: number;
  network: EnvProfile['network'];
  logSink: EnvProfile['logSink'];
  llmAllowed: boolean;
  llmCostCapUsd: number;
}

export type PositionSplit = 'dev' | 'held-out';

export interface PositionRecord {
  id: string;
  source: 'generated' | 'mined';
  split: PositionSplit;
  seed: number;
  turn: number;
  side: SideId;
  inputLog: string;
  label: string;
  labelDepth: number;
}
