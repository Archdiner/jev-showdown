import { createHash } from 'crypto';

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = sortKeys(child);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** Content hash of the strategy object. Env profiles are not part of this. */
export function configIdOf(config: unknown): string {
  return createHash('sha256').update(canonicalJson(config)).digest('hex').slice(0, 16);
}
