import * as fs from 'fs';
import * as path from 'path';
import { RandbatsStats, SpeciesStats } from '../types/index.js';

export class DataLoader {
  private static instance: DataLoader;
  private sets: Record<string, any> = {};
  private stats: RandbatsStats = {};
  private loaded = false;

  private constructor() {}

  static getInstance(): DataLoader {
    if (!DataLoader.instance) {
      DataLoader.instance = new DataLoader();
    }
    return DataLoader.instance;
  }

  async load(): Promise<void> {
    if (this.loaded) return;

    const dataDir = path.join(process.cwd(), 'data');
    
    const setsPath = path.join(dataDir, 'gen9-sets.json');
    const statsPath = path.join(dataDir, 'gen9-stats.json');

    if (!fs.existsSync(setsPath) || !fs.existsSync(statsPath)) {
      throw new Error(
        'Data files not found. Run `npm run data:refresh` first.'
      );
    }

    this.sets = JSON.parse(fs.readFileSync(setsPath, 'utf-8'));
    this.stats = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
    this.loaded = true;
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
