import * as fs from 'fs/promises';
import * as path from 'path';
import { Dex } from '@pkmn/sim';
import { dataDir } from './paths.js';

interface DataMetadata {
  lastChecked: string;
  setsHash: string;
  statsHash: string;
  simVersion: string;
  setsSpeciesCount: number;
  statsSpeciesCount: number;
}

interface FreshnessResult {
  upToDate: boolean;
  changes: string[];
  warnings: string[];
  metadata: DataMetadata;
}

export class FreshnessChecker {
  private static readonly CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
  private currentDir = '';

  /**
   * Check if data is fresh. Auto-refresh if stale or changed.
   * Returns whether refresh occurred and what changed.
   * Writes go to `sources.dir` or `JEV_DATA_DIR`, never a hard-coded path.
   */
  async checkAndRefresh(sources: {
    setsUrl: string;
    statsUrl?: string;
    dir?: string;
  }): Promise<FreshnessResult> {
    this.currentDir = sources.dir ?? dataDir();
    const changes: string[] = [];
    const warnings: string[] = [];
    
    // Load or create metadata
    let metadata = await this.loadMetadata();
    
    // Check if we should skip (checked recently)
    if (metadata && !this.shouldCheck(metadata)) {
      return {
        upToDate: true,
        changes: [],
        warnings: [],
        metadata,
      };
    }
    
    console.log('[Freshness] Checking data freshness...');
    
    // Check sets
    const setsChanged = await this.checkSets(sources.setsUrl, metadata);
    if (setsChanged.changed) {
      changes.push(...setsChanged.changes);
      metadata = setsChanged.newMetadata;
    }
    
    // Check stats if URL provided
    if (sources.statsUrl) {
      const statsChanged = await this.checkStats(sources.statsUrl, metadata);
      if (statsChanged.changed) {
        changes.push(...statsChanged.changes);
        metadata = statsChanged.newMetadata;
      }
    }
    
    // Check sim version
    const simVersion = this.getSimVersion();
    if (metadata.simVersion !== simVersion) {
      changes.push(`@pkmn/sim version changed: ${metadata.simVersion} → ${simVersion}`);
      metadata.simVersion = simVersion;
      warnings.push(
        `@pkmn/sim version ${simVersion} may differ from live server. ` +
        `Check https://github.com/smogon/pokemon-showdown for latest.`
      );
    }
    
    // Update metadata timestamp
    metadata.lastChecked = new Date().toISOString();
    await this.saveMetadata(metadata);
    
    // Log results
    if (changes.length > 0) {
      console.log('[Freshness] Changes detected:');
      changes.forEach(c => console.log(`  - ${c}`));
    } else {
      console.log('[Freshness] Data is up to date');
    }
    
    if (warnings.length > 0) {
      console.warn('[Freshness] Warnings:');
      warnings.forEach(w => console.warn(`  ⚠ ${w}`));
    }
    
    return {
      upToDate: changes.length === 0,
      changes,
      warnings,
      metadata,
    };
  }
  
  private shouldCheck(metadata: DataMetadata): boolean {
    const lastCheck = new Date(metadata.lastChecked);
    const now = new Date();
    return now.getTime() - lastCheck.getTime() > FreshnessChecker.CHECK_INTERVAL_MS;
  }
  
  private async checkSets(
    url: string,
    metadata: DataMetadata
  ): Promise<{ changed: boolean; changes: string[]; newMetadata: DataMetadata }> {
    const changes: string[] = [];
    const localPath = this.file('gen9-sets.json');
    
    // Fetch remote
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch sets: HTTP ${response.status}`);
    }
    const remoteSets = await response.json();
    const remoteHash = this.hashObject(remoteSets);
    
    // Compare with local
    const changed = remoteHash !== metadata.setsHash;
    
    if (changed) {
      const localSets = await this.loadJSON(localPath).catch(() => ({}));
      const remoteSpecies = Object.keys(remoteSets as Record<string, any>);
      const localSpecies = Object.keys(localSets);
      
      const added = remoteSpecies.filter(s => !localSpecies.includes(s));
      const removed = localSpecies.filter(s => !remoteSpecies.includes(s));
      
      if (added.length > 0) {
        changes.push(`Species added (${added.length}): ${added.slice(0, 5).join(', ')}${added.length > 5 ? '...' : ''}`);
      }
      if (removed.length > 0) {
        changes.push(`Species removed (${removed.length}): ${removed.slice(0, 5).join(', ')}${removed.length > 5 ? '...' : ''}`);
      }
      
      // Check level changes
      const levelChanges: string[] = [];
      const remoteSetsObj = remoteSets as Record<string, any>;
      for (const species of remoteSpecies) {
        if (localSets[species] && remoteSetsObj[species]) {
          const oldLevel = localSets[species].level;
          const newLevel = remoteSetsObj[species].level;
          if (oldLevel !== newLevel && levelChanges.length < 5) {
            levelChanges.push(`${species}: ${oldLevel} → ${newLevel}`);
          }
        }
      }
      if (levelChanges.length > 0) {
        changes.push(`Level changes: ${levelChanges.join(', ')}`);
      }
      
      // Save updated sets
      await fs.writeFile(localPath, JSON.stringify(remoteSets, null, 2));
      console.log(`[Freshness] Updated sets: ${remoteSpecies.length} species`);
      
      metadata.setsHash = remoteHash;
      metadata.setsSpeciesCount = remoteSpecies.length;
    }
    
    return { changed, changes, newMetadata: metadata };
  }
  
  private async checkStats(
    url: string,
    metadata: DataMetadata
  ): Promise<{ changed: boolean; changes: string[]; newMetadata: DataMetadata }> {
    const changes: string[] = [];
    const localPath = this.file('gen9-stats.json');
    
    // Fetch remote
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch stats: HTTP ${response.status}`);
    }
    const remoteStats = await response.json();
    const remoteHash = this.hashObject(remoteStats);
    
    // Compare with local
    const changed = remoteHash !== metadata.statsHash;
    
    if (changed) {
      const localStats = await this.loadJSON(localPath).catch(() => ({}));
      const remoteCount = Object.keys(remoteStats as Record<string, any>).length;
      const localCount = Object.keys(localStats).length;
      
      if (remoteCount !== localCount) {
        changes.push(`Stats species count: ${localCount} → ${remoteCount}`);
      }
      
      // Save updated stats
      await fs.writeFile(localPath, JSON.stringify(remoteStats, null, 2));
      console.log(`[Freshness] Updated stats: ${remoteCount} species`);
      
      metadata.statsHash = remoteHash;
      metadata.statsSpeciesCount = remoteCount;
    }
    
    return { changed, changes, newMetadata: metadata };
  }
  
  private async loadMetadata(): Promise<DataMetadata> {
    try {
      const data = await fs.readFile(this.file('metadata.json'), 'utf-8');
      return JSON.parse(data);
    } catch {
      // Create default metadata
      return {
        lastChecked: new Date(0).toISOString(),
        setsHash: '',
        statsHash: '',
        simVersion: this.getSimVersion(),
        setsSpeciesCount: 0,
        statsSpeciesCount: 0,
      };
    }
  }
  
  private async saveMetadata(metadata: DataMetadata): Promise<void> {
    await fs.mkdir(this.currentDir || dataDir(), { recursive: true });
    await fs.writeFile(this.file('metadata.json'), JSON.stringify(metadata, null, 2));
  }
  
  private async loadJSON(path: string): Promise<any> {
    const data = await fs.readFile(path, 'utf-8');
    return JSON.parse(data);
  }
  
  private hashObject(obj: any): string {
    // Simple hash: JSON stringify + length + sample keys
    const str = JSON.stringify(obj);
    const keys = Object.keys(obj).slice(0, 10).join(',');
    return `${str.length}:${keys}`;
  }
  
  private file(name: string): string {
    return path.join(this.currentDir || dataDir(), name);
  }

  private getSimVersion(): string {
    return (Dex as any).modVersion || 'unknown';
  }
}

export const freshnessChecker = new FreshnessChecker();
