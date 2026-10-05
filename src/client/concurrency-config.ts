import * as fs from 'fs';
import * as path from 'path';

/** Safety ceiling for one login. Showdown may throttle earlier; that is not a client hard cap. */
export const ABSOLUTE_MAX_CONCURRENCY = 16;

/** Used when no engine profile, config file, or CLI flag sets a limit. */
export const DEFAULT_CONCURRENCY = 1;

/** Steady limits when `--use-engine-profile` is set. Grok stays at 1 (calls are ~25s). */
export const ENGINE_CONCURRENCY_LIMITS: Record<string, number> = {
  search: 3,
  'max-damage': 4,
  grok: 1,
  strategist: 1,
};

export const DEFAULT_CONCURRENCY_CONFIG = path.resolve('configs/live/concurrency.json');

export interface ConcurrencyFile {
  default?: number;
  engines?: Record<string, number>;
}

export function clampLimit(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    throw new Error('--concurrency must be a positive number');
  }
  return Math.min(ABSOLUTE_MAX_CONCURRENCY, Math.floor(value));
}

export function selectLiveEngine(name: string): {
  engine: 'search' | 'max-damage' | 'strategist';
  profile: string;
  useLLMPrior: boolean;
} {
  const id = name.trim().toLowerCase();
  if (id === 'strategist') return { engine: 'strategist', profile: 'strategist', useLLMPrior: false };
  if (id === 'grok' || id === 'llm') return { engine: 'search', profile: 'grok', useLLMPrior: true };
  if (id === 'search' || id === 'exact' || id === 'exact-1ply' || id === 'robust' || id === 'champion') {
    return { engine: 'search', profile: 'search', useLLMPrior: false };
  }
  if (id === 'max-damage' || id === 'maxdamage' || id === 'maxdamage-v1') {
    return { engine: 'max-damage', profile: 'max-damage', useLLMPrior: false };
  }
  throw new Error(`Unknown engine "${name}". Use search, exact, max-damage, grok, or strategist.`);
}

/**
 * Resolution order: global default, engine profile, config file, then CLI.
 * `--runners` multiplies the chosen limit (ops `live --runners=N --concurrency=K`).
 * The result is clamped to [1, ABSOLUTE_MAX_CONCURRENCY].
 */
export function resolveConcurrencyLimit(input: {
  engine: string;
  useEngineProfile: boolean;
  concurrency?: number | null;
  runners?: number | null;
  file?: ConcurrencyFile | null;
}): { profile: string; limit: number } {
  const profile = input.engine.trim().toLowerCase();
  let limit = DEFAULT_CONCURRENCY;
  if (input.useEngineProfile) {
    const builtin = ENGINE_CONCURRENCY_LIMITS[profile];
    if (builtin === undefined) {
      throw new Error(`No concurrency profile for "${input.engine}". Use search, max-damage, grok, or strategist.`);
    }
    limit = builtin;
  }
  const fromFile = input.file?.engines?.[profile];
  if (fromFile !== undefined) limit = fromFile;
  else if (input.file?.default !== undefined && !input.useEngineProfile) limit = input.file.default;
  if (input.concurrency != null) limit = input.concurrency;
  if (input.runners != null && input.runners > 1) limit *= Math.floor(input.runners);
  return { profile, limit: clampLimit(limit) };
}

export function loadConcurrencyFile(filePath: string): ConcurrencyFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read concurrency config ${filePath}: ${message}`);
  }
  return parseConcurrencyFile(parsed, filePath);
}

export function loadDefaultConcurrencyFile(): ConcurrencyFile | null {
  if (!fs.existsSync(DEFAULT_CONCURRENCY_CONFIG)) return null;
  return loadConcurrencyFile(DEFAULT_CONCURRENCY_CONFIG);
}

function parseConcurrencyFile(value: unknown, filePath: string): ConcurrencyFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Concurrency config ${filePath} must be a JSON object`);
  }
  const raw = value as Record<string, unknown>;
  const file: ConcurrencyFile = {};
  if (raw.default !== undefined) file.default = expectPositive(raw.default, 'default', filePath);
  if (raw.engines !== undefined) {
    if (!raw.engines || typeof raw.engines !== 'object' || Array.isArray(raw.engines)) {
      throw new Error(`Concurrency config ${filePath} engines must be an object`);
    }
    file.engines = {};
    for (const [name, limit] of Object.entries(raw.engines as Record<string, unknown>)) {
      file.engines[name.trim().toLowerCase()] = expectPositive(limit, `engines.${name}`, filePath);
    }
  }
  return file;
}

function expectPositive(value: unknown, label: string, filePath: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new Error(`Concurrency config ${filePath} ${label} must be a positive number`);
  }
  return value;
}
