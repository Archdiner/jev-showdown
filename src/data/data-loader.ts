import * as fs from 'fs';
import * as path from 'path';
import { RandbatsStats, SpeciesStats } from '../types/index.js';
import { Format } from '../types/format.js';
import { freshnessChecker } from './freshness-checker.js';

export class DataLoader {
  private static instance: DataLoader;
  private sets: Record<string, any> = {};
  private stats: RandbatsStats = {};
  private loaded = false;
  private format?: Format;

  constructor(private readonly dataDir?: string) {}

  static getInstance(): DataLoader {
    if (!DataLoader.instance) {
      DataLoader.instance = new DataLoader();
    }
    return DataLoader.instance;
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
  }

  /**
   * Load data with freshness checking.
   * Automatically refreshes if data is stale.
   * `dataDir` skips the refresh and reads that directory instead of `data/`.
   */
  async load(format?: Format, options?: { dataDir?: string }): Promise<void> {
    if (this.loaded) return;

    this.format = format;
    
    const dataDir = options?.dataDir ?? this.dataDir ?? path.join(process.cwd(), 'data');
    const setsPath = path.join(dataDir, 'gen9-sets.json');
    const statsPath = path.join(dataDir, 'gen9-stats.json');

    // Check freshness if format provided. A test directory is read as-is.
    if (format && !options?.dataDir && !this.dataDir) {
      try {
        const freshnessResult = await freshnessChecker.checkAndRefresh({
          setsUrl: format.dataSources.setsUrl,
          statsUrl: format.dataSources.statsUrl,
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

    // Load data files
    if (!fs.existsSync(setsPath) || !fs.existsSync(statsPath)) {
      throw new Error(
        'Data files not found. Run `npm run data:refresh` first.'
      );
    }

    this.sets = JSON.parse(fs.readFileSync(setsPath, 'utf-8'));
    this.stats = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
    
    // Initialize format with data
    if (format) {
      await format.initialize({ sets: this.sets, stats: this.stats });
    }
    
    this.loaded = true;
    
    console.log(`[DataLoader] Loaded ${Object.keys(this.sets).length} species sets, ${Object.keys(this.stats).length} species stats`);
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
