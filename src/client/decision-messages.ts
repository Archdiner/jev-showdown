import { Action, BotConfig, GameState } from '../types/index.js';

export interface DecideRequest {
  type: 'decide';
  id: number;
  state: GameState;
  legal: Action[];
}

export interface InitRequest {
  type: 'init';
  config: BotConfig;
}

export type WorkerRequest = InitRequest | DecideRequest;

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
