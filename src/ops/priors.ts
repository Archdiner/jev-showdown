import * as fs from 'fs';
import * as path from 'path';
import { Dex } from '@pkmn/dex';
import { CategoryPriorsSchema, type CategoryPriors } from '../config/schema.js';
import type { OpsPaths } from './paths.js';

export interface PriorCounts {
  physical: number;
  special: number;
  status: number;
  hazard: number;
  setup: number;
  priority: number;
  switch: number;
  games: number;
}

export function emptyCounts(): PriorCounts {
  return { physical: 0, special: 0, status: 0, hazard: 0, setup: 0, priority: 0, switch: 0, games: 0 };
}

/** Count opponent categories. The result is a weight vector, not a move-id table. */
export function observeLog(text: string, counts: PriorCounts): void {
  counts.games += 1;
  for (const line of text.split('\n')) {
    if ((line.startsWith('|switch|') || line.startsWith('|drag|')) && line.includes('|p2')) counts.switch += 1;
    const move = line.match(/^\|move\|p2[^|:]*:\s*([^|]+)/);
    if (!move) continue;
    const data = Dex.moves.get(move[1].trim());
    if (!data.exists) continue;
    if (data.category === 'Physical') counts.physical += 1;
    else if (data.category === 'Special') counts.special += 1;
    else counts.status += 1;
    if (data.priority > 0) counts.priority += 1;
    if (data.boosts) counts.setup += 1;
    if (data.target === 'foeSide' && data.sideCondition) counts.hazard += 1;
  }
}

export function countsToPriors(counts: PriorCounts): CategoryPriors {
  const moves = Math.max(1, counts.physical + counts.special + counts.status);
  return CategoryPriorsSchema.parse({
    physical: counts.physical / moves,
    special: counts.special / moves,
    status: counts.status / moves,
    hazard: 1 + counts.hazard / moves,
    setup: 1 + counts.setup / moves,
    priority: 1 + counts.priority / moves,
    switch: 1 + counts.switch / Math.max(1, counts.games),
  });
}

export function readCounts(paths: OpsPaths): PriorCounts {
  const file = `${paths.priors}.counts.json`;
  if (!fs.existsSync(file)) return emptyCounts();
  return { ...emptyCounts(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
}

export function writePriors(paths: OpsPaths, counts: PriorCounts): CategoryPriors {
  fs.mkdirSync(path.dirname(paths.priors), { recursive: true });
  fs.writeFileSync(`${paths.priors}.counts.json`, JSON.stringify(counts, null, 2));
  const priors = countsToPriors(counts);
  fs.writeFileSync(paths.priors, JSON.stringify(priors, null, 2));
  return priors;
}

export async function scrapeReplay(url: string): Promise<string> {
  const target = url.startsWith('http')
    ? (url.endsWith('.json') ? url : `${url}.json`)
    : `https://replay.pokemonshowdown.com/${url}.json`;
  const response = await fetch(target);
  if (!response.ok) throw new Error(`replay ${response.status}`);
  const body = await response.json() as { log?: string };
  if (!body.log) throw new Error('replay has no log');
  return body.log;
}
