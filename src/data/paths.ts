import * as path from 'path';

/** Below this, gen9 random battles are a stub, not the ladder metagame. */
export const MIN_SPECIES = 500;

/** Overrides the data directory. Tests point this at a temp dir. */
export const DATA_DIR_ENV = 'JEV_DATA_DIR';

/**
 * Test-only. When `1` or `true`, the loader accepts fewer than {@link MIN_SPECIES}.
 * Benchmarks, self-play, the ladder, and live preflight do not set this.
 */
export const ALLOW_SMALL_DATA_ENV = 'JEV_ALLOW_SMALL_DATA';

export function dataDir(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const override = env[DATA_DIR_ENV];
  if (override && override.trim()) return path.resolve(cwd, override.trim());
  return path.join(cwd, 'data');
}

export function allowSmallData(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[ALLOW_SMALL_DATA_ENV];
  return value === '1' || value === 'true';
}
