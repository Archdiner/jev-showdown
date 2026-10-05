import * as fs from 'fs';
import * as path from 'path';
import { dataLoader } from './data-loader.js';
import { DataManifest, formatDataLine } from './manifest.js';

/**
 * Prints the species count and data hash, and writes them onto a results file.
 * Benchmarks and self-play call this after a successful load.
 */
export function publishDataResult(resultsFile: string, body: Record<string, unknown>): DataManifest {
  const manifest = dataLoader.manifest();
  console.log(formatDataLine(manifest));
  const payload = {
    species: manifest.species,
    dataHash: manifest.hash,
    setsSpecies: manifest.setsSpecies,
    statsSpecies: manifest.statsSpecies,
    dataDir: manifest.dir,
    ...body,
  };
  const file = path.resolve(resultsFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`[data] results ${file}`);
  return manifest;
}
