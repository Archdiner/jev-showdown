/** Deep-merge plain objects. Arrays and scalars in the override replace the base. */
export function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined) return clone(base);
  if (override === null || typeof override !== 'object' || Array.isArray(override)) {
    return clone(override) as T;
  }
  if (!base || typeof base !== 'object' || Array.isArray(base)) {
    return clone(override) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const key of Object.keys(override as Record<string, unknown>)) {
    const next = (override as Record<string, unknown>)[key];
    out[key] = key in out ? deepMerge(out[key], next) : clone(next);
  }
  return out as T;
}

export function clone<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
