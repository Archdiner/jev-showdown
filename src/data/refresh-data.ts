#!/usr/bin/env node

import * as fs from 'fs/promises';
import * as path from 'path';
import { dataDir } from './paths.js';

const SOURCES = {
  sets: 'https://raw.githubusercontent.com/smogon/pokemon-showdown/master/data/random-battles/gen9/sets.json',
  stats: 'https://pkmn.github.io/randbats/data/stats/gen9randombattle.json',
  formats: 'https://raw.githubusercontent.com/smogon/pokemon-showdown/master/config/formats.ts',
};

async function fetchJSON(url: string): Promise<any> {
  console.log(`Fetching ${url}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }
  return response.json();
}

async function fetchText(url: string): Promise<string> {
  console.log(`Fetching ${url}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }
  return response.text();
}

async function main() {
  const dir = dataDir();
  await fs.mkdir(dir, { recursive: true });

  const sets = await fetchJSON(SOURCES.sets);
  await fs.writeFile(
    path.join(dir, 'gen9-sets.json'),
    JSON.stringify(sets, null, 2)
  );
  console.log(`✓ Saved gen9-sets.json (${Object.keys(sets).length} species)`);

  const stats = await fetchJSON(SOURCES.stats);
  await fs.writeFile(
    path.join(dir, 'gen9-stats.json'),
    JSON.stringify(stats, null, 2)
  );
  console.log(`✓ Saved gen9-stats.json (${Object.keys(stats).length} species)`);

  const formats = await fetchText(SOURCES.formats);
  await fs.writeFile(path.join(dir, 'formats.ts'), formats);
  console.log(`✓ Saved formats.ts`);

  console.log('\n✓ Data refresh complete');
  console.log(`Last updated: ${new Date().toISOString()}`);
  console.log('\nReminder: Re-run this monthly after balance patches');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
