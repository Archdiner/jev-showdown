import * as fs from 'fs';
import * as path from 'path';
import { RandbatsStats, SpeciesStats } from '../types/index.js';
import { Format } from '../types/format.js';
import { freshnessChecker } from './freshness-checker.js';
import { allowSmallData, dataDir } from './paths.js';
import { assertSpeciesFloor, DataManifest, readDataManifest } from './manifest.js';

export interface LoadOptions {
  /** Overrides {@link allowSmallData}. `false` enforces the species floor even when the env flag is set. */
  allowSmall?: boolean;
  /** Overrides {@link dataDir}. A set directory is read as-is and skips the refresh. */
  dir?: string;
  /** Same override as `dir`. Callers that pass a temp directory use this name. */
  dataDir?: string;
}

export class DataLoader {
  private static instance: DataLoader;
  private sets: Record<string, any> = {};
  private stats: RandbatsStats = {};
  private loaded = false;
  private format?: Format;
  private loadedManifest?: DataManifest;

  constructor(private readonly dataDir?: string) {}

  static getInstance(): DataLoader {
    if (!DataLoader.instance) {
      DataLoader.instance = new DataLoader();
    }
    return DataLoader.instance;
  }

  /** A loader that does not share the process singleton. Tests use this for the species floor. */
  static isolated(): DataLoader {
    return new DataLoader();
  }

  /**
   * Drop the singleton cache. Tests use this with a temp directory so they
   * never write `data/gen9-stats.json`.
   */
  static resetForTests(): void {
    const current = DataLoader.instance;
    if (!current) return;
    current.sets = {};
    current.stats = {};
    current.loaded = false;
    current.format = undefined;
    current.loadedManifest = undefined;
  }

  /**
   * Load data with freshness checking.
   * Automatically refreshes if data is stale.
   * Throws when the table has fewer than 500 species, unless the test-only flag is set.
   * `dir` or `dataDir` reads that directory as-is and skips the refresh.
   */
  async load(format?: Format, options?: LoadOptions): Promise<DataManifest> {
    if (this.loaded && this.loadedManifest) return this.loadedManifest;

    this.format = format;
    const override = options?.dir ?? options?.dataDir ?? this.dataDir;
    const dir = override ?? dataDir();
    const setsPath = path.join(dir, 'gen9-sets.json');
    const statsPath = path.join(dir, 'gen9-stats.json');

    if (format && !override) {
      try {
        const freshnessResult = await freshnessChecker.checkAndRefresh({
          setsUrl: format.dataSources.setsUrl,
          statsUrl: format.dataSources.statsUrl,
          dir,
        });

        if (freshnessResult.changes.length > 0) {
          console.log('[DataLoader] Data was refreshed with changes:');
          freshnessResult.changes.forEach(c => console.log(`  - ${c}`));
        }

        if (freshnessResult.warnings.length > 0) {
          freshnessResult.warnings.forEach(w => console.warn(`  ⚠ ${w}`));
        }
      } catch (e) {
        console.warn('[DataLoader] Freshness check failed, using cached data:', e);
      }
    }

    const manifest = readDataManifest(dir);
    const allowSmall = options?.allowSmall !== undefined ? options.allowSmall : allowSmallData();
    assertSpeciesFloor(manifest, allowSmall);

    this.sets = JSON.parse(fs.readFileSync(setsPath, 'utf-8'));
    this.stats = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));

    if (format) {
      await format.initialize({ sets: this.sets, stats: this.stats });
    }

    this.loaded = true;
    this.loadedManifest = manifest;

    console.log(`[DataLoader] species=${manifest.species} hash=${manifest.hash}`);
    return manifest;
  }

  manifest(): DataManifest {
    this.ensureLoaded();
    return this.loadedManifest as DataManifest;
  }

  getSets(): Record<string, any> {
    this.ensureLoaded();
    return this.sets;
  }

  getStats(): RandbatsStats {
    this.ensureLoaded();
    return this.stats;
  }

  getSpeciesStats(species: string): SpeciesStats | undefined {
    this.ensureLoaded();
    return this.stats[species];
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      throw new Error('DataLoader not loaded. Call load() first.');
    }
  }
}

export const dataLoader = DataLoader.getInstance();
