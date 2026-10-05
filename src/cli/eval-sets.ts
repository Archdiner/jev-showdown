#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import type { RandbatsStats } from '../types/index.js';
import { evaluateSets, formatEvalReport } from '../engine/set-inference/evaluate.js';

const STATS_URL = 'https://pkmn.github.io/randbats/data/stats/gen9randombattle.json';
const MIN_SPECIES = 400;

function arg(name: string, fallback: string): string {
  const hit = process.argv.find(token => token.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

/**
 * Read the canonical stats file. A stub is refused and never replaced.
 * A missing file is fetched into memory and not written.
 */
async function loadStats(): Promise<RandbatsStats> {
  const file = path.join(process.cwd(), 'data', 'gen9-stats.json');
  if (fs.existsSync(file)) {
    const stats = JSON.parse(fs.readFileSync(file, 'utf8')) as RandbatsStats;
    const count = Object.keys(stats).length;
    if (count < MIN_SPECIES) {
      throw new Error(
        `data/gen9-stats.json has ${count} species. Refusing to overwrite it. ` +
        'Delete the stub yourself, then run `npm run data:refresh`.',
      );
    }
    console.log(`stats file=${file} species=${count}`);
    return stats;
  }
  console.log(`stats file missing; fetching ${STATS_URL} (not written)`);
  const response = await fetch(STATS_URL);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${STATS_URL}`);
  const stats = await response.json() as RandbatsStats;
  const count = Object.keys(stats).length;
  if (count < MIN_SPECIES) throw new Error(`Fetched stats have only ${count} species`);
  console.log(`stats fetched species=${count}`);
  return stats;
}

const stats = await loadStats();
const report = evaluateSets({
  stats,
  games: Number(arg('games', '40')),
  seedStart: Number(arg('seed', '1')),
  maxTurns: Number(arg('turns', '36')),
});
console.log(formatEvalReport(report));
