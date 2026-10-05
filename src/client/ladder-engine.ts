import { createHash } from 'node:crypto';
import { specFromId, PolicySpec } from '../engine/exact/policies.js';
import { EngineName } from './engines.js';

/**
 * Ids the gate already passes to `specFromId`.
 * `search` is the promoted exact 1-ply champion. `exact` is an alias of it.
 * `max-damage` is the frozen @smogon/calc baseline.
 */
export function ladderConfigId(engine: EngineName): string {
  return engine === 'max-damage' ? 'maxdamage-v1' : 'champion-exact-1ply';
}

/** The policy object the gate would build for this ladder engine. */
export function ladderPolicy(engine: EngineName): PolicySpec {
  return specFromId(ladderConfigId(engine));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>).sort();
    return `{${entries.map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Stable hash of a policy, including sample count and every search field. */
export function policyHash(spec: PolicySpec): string {
  return createHash('sha256').update(canonical(spec)).digest('hex');
}
