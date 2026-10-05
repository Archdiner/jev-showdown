import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ALLOW_SMALL_DATA_ENV, MIN_SPECIES } from './paths.js';

export interface DataManifest {
  dir: string;
  /** min(sets, stats). The floor uses this so a one-species stats stub cannot hide behind a full sets file. */
  species: number;
  setsSpecies: number;
  statsSpecies: number;
  /** sha256 of the sets file bytes, a newline, and the stats file bytes. */
  hash: string;
}

export function formatDataLine(manifest: DataManifest): string {
  return `data species=${manifest.species} hash=${manifest.hash}`;
}

export function readDataManifest(dir: string): DataManifest {
  const setsPath = path.join(dir, 'gen9-sets.json');
  const statsPath = path.join(dir, 'gen9-stats.json');
  if (!fs.existsSync(setsPath) || !fs.existsSync(statsPath)) {
    throw new Error(`Data files not found in ${dir}. Run \`npm run data:refresh\` first.`);
  }
  const setsBytes = fs.readFileSync(setsPath);
  const statsBytes = fs.readFileSync(statsPath);
  const sets = JSON.parse(setsBytes.toString('utf8')) as Record<string, unknown>;
  const stats = JSON.parse(statsBytes.toString('utf8')) as Record<string, unknown>;
  if (!sets || typeof sets !== 'object' || Array.isArray(sets)) {
    throw new Error(`gen9-sets.json in ${dir} is not a species map`);
  }
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) {
    throw new Error(`gen9-stats.json in ${dir} is not a species map`);
  }
  const setsSpecies = Object.keys(sets).length;
  const statsSpecies = Object.keys(stats).length;
  const species = Math.min(setsSpecies, statsSpecies);
  const hash = crypto.createHash('sha256').update(setsBytes).update('\n').update(statsBytes).digest('hex');
  return { dir, species, setsSpecies, statsSpecies, hash };
}

/**
 * Throws when the manifest is too small to be the real randbats table.
 * `allowSmall` is the explicit test-only escape hatch.
 */
export function assertSpeciesFloor(manifest: DataManifest, allowSmall: boolean): void {
  if (allowSmall || manifest.species >= MIN_SPECIES) return;
  throw new Error(
    `DataLoader refused ${manifest.statsSpecies} stats species and ${manifest.setsSpecies} set species ` +
    `in ${manifest.dir} (minimum ${MIN_SPECIES}, hash=${manifest.hash}). ` +
    `A short file is a test stub, not the ladder metagame. ` +
    `Set ${ALLOW_SMALL_DATA_ENV}=1 only in tests.`,
  );
}
