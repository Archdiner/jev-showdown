import { Action, BotConfig, GameState } from '../types/index.js';
import { damageEvaluator } from '../engine/damage-evaluator.js';

/** Official Showdown rejects a 6th simultaneous game. */
export const MAX_LADDER_CONCURRENCY = 5;

export type EngineName = 'search' | 'max-damage';

export const ENGINE_NAMES: EngineName[] = ['search', 'max-damage'];

export function parseEngine(name: string): EngineName {
  const id = name.trim().toLowerCase();
  if (id === 'search' || id === 'robust' || id === 'champion') return 'search';
  if (id === 'max-damage' || id === 'maxdamage' || id === 'maxdamage-v1') return 'max-damage';
  throw new Error(`Unknown engine "${name}". Use search or max-damage.`);
}

export function clampConcurrency(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    throw new Error('--concurrency must be a positive number');
  }
  return Math.min(MAX_LADDER_CONCURRENCY, Math.floor(value));
}

/**
 * Split the configured search budget across decisions that are in flight.
 * Each battle still has its own timer; this only caps CPU per wave.
 */
export function budgetSearchMs(baseMs: number, inFlight: number): number {
  const n = Math.max(1, Math.floor(inFlight));
  return Math.max(50, Math.floor(baseMs / n));
}

/** Stateless max-damage choice. A new call shares no battle memory. */
export function maxDamageAction(state: GameState, legal: Action[]): Action {
  const moves = legal.filter(action => action.type === 'move');
  if (moves.length === 0) return legal[0];
  return damageEvaluator.getBestDamageAction(state, moves);
}

export function freshConfig(config: BotConfig, searchTimeMs: number): BotConfig {
  return {
    ...config,
    searchTimeMs,
    llmConfig: config.llmConfig ? { ...config.llmConfig } : undefined,
  };
}
