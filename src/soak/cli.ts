#!/usr/bin/env node

import { SoakError, runSoak, type SoakPhase } from './run.js';

/**
 * Ladder soak.
 *   npm run test:soak
 *   npm run test:soak -- --ci
 *   npm run test:soak -- --fault-only
 *
 * `--ci` (or CI=true) plays one clean game, one fault-injection game, and a drain.
 * The default plays two clean games. Concurrency stays 3 unless `--concurrency` is set.
 */
function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: npm run test:soak -- [--ci] [--games N] [--concurrency N] [--engine name] [--fault-only] [--skip-fault] [--skip-drain]`);
    return Promise.resolve();
  }
  const ci = argv.includes('--ci') || process.env.CI === 'true';
  const games = flagNumber(argv, '--games', ci ? 1 : 2);
  const concurrency = flagNumber(argv, '--concurrency', 3);
  const engine = flagValue(argv, '--engine', 'max-damage');
  const phases: SoakPhase[] = [];
  if (argv.includes('--fault-only')) phases.push('fault');
  else {
    phases.push('clean');
    if (!argv.includes('--skip-fault')) phases.push('fault');
    if (!argv.includes('--skip-drain')) phases.push('drain');
  }
  return runSoak({ games, concurrency, engine, phases }).then(report => {
    console.log(`[soak] phases=${report.phases.map(phase => phase.phase).join(',')} total=${report.elapsedMs}ms`);
  });
}

function flagValue(argv: string[], name: string, fallback: string): string {
  const index = argv.indexOf(name);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  return fallback;
}

function flagNumber(argv: string[], name: string, fallback: number): number {
  const raw = flagValue(argv, name, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new SoakError(`${name} must be a positive integer`);
  return value;
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
