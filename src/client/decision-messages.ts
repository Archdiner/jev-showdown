import { Action, BotConfig, GameState } from '../types/index.js';
import { LivePosition } from './decision-battle.js';
import { EngineName } from './engines.js';

export interface DecideRequest {
  type: 'decide';
  id: number;
  battleId: string;
  state: GameState;
  legal: Action[];
  searchTimeMs: number;
  position?: LivePosition;
}

export interface InitRequest {
  type: 'init';
  config: BotConfig;
  engine: EngineName;
  /** Gatekeeper champion file for this batch. Absent means the builtin policy. */
  championConfigPath?: string | null;
}

export interface OpenBattleRequest {
  type: 'open-battle';
  battleId: string;
  /** Set when this battle was routed to a config. Absent keeps the worker default. */
  configPath?: string | null;
  engine?: EngineName;
}

export interface CloseBattleRequest {
  type: 'close-battle';
  battleId: string;
}

export type WorkerRequest = InitRequest | DecideRequest | OpenBattleRequest | CloseBattleRequest;

export interface DecisionResponse {
  type: 'decision';
  id: number;
  action: Action;
  score: number | null;
  timeMs: number;
  fallback: boolean;
  reason?: string;
}

export interface ReadyResponse {
  type: 'ready';
}

export interface WorkerErrorResponse {
  type: 'worker-error';
  message: string;
}

export type WorkerResponse = DecisionResponse | ReadyResponse | WorkerErrorResponse;
