import { ABSOLUTE_MAX_CONCURRENCY, clampLimit } from './concurrency-config.js';

/** Client safety ceiling. The server can still throttle sooner. */
export const MAX_LADDER_CONCURRENCY = ABSOLUTE_MAX_CONCURRENCY;

export type EngineName = 'search' | 'max-damage' | 'hybrid';

export const ENGINE_NAMES: EngineName[] = ['search', 'max-damage', 'hybrid'];

export function parseEngine(name: string): EngineName {
  const id = name.trim().toLowerCase();
  // `exact` is the promoted 1-ply search. `search` is that same engine.
  // `hybrid` is sampled-world search plus optional LLM layers. It is not the champion.
  if (id === 'hybrid' || id === 'hybrid-full') return 'hybrid';
  if (id === 'search' || id === 'exact' || id === 'robust' || id === 'champion') return 'search';
  if (id === 'max-damage' || id === 'maxdamage' || id === 'maxdamage-v1') return 'max-damage';
  throw new Error(`Unknown engine "${name}". Use search, exact, max-damage, or hybrid.`);
}

export function clampConcurrency(value: number): number {
  return clampLimit(value);
}

/**
 * Split the configured search budget across decisions that are in flight.
 * Each battle still has its own timer; this only caps CPU per wave.
 */
export function budgetSearchMs(baseMs: number, inFlight: number): number {
  const n = Math.max(1, Math.floor(inFlight));
  return Math.max(50, Math.floor(baseMs / n));
}
