import { Action, BotConfig, GameState } from '../types/index.js';
import { EngineName } from './engines.js';

export interface DecideRequest {
  type: 'decide';
  id: number;
  battleId: string;
  state: GameState;
  legal: Action[];
  searchTimeMs: number;
}

export interface InitRequest {
  type: 'init';
  config: BotConfig;
  engine: EngineName;
}

export interface OpenBattleRequest {
  type: 'open-battle';
  battleId: string;
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
