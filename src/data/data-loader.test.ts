import { describe, it, expect, beforeAll } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataLoader, dataLoader } from './data-loader.js';
import { writeSpeciesFixture } from './fixture.js';
import { formatDataLine, readDataManifest } from './manifest.js';
import { dataDir, MIN_SPECIES } from './paths.js';

const canonicalStats = path.join(process.cwd(), 'data', 'gen9-stats.json');
const canonicalBefore = fs.existsSync(canonicalStats) ? fs.readFileSync(canonicalStats) : null;

describe('DataLoader', () => {
  beforeAll(() => {
    writeSpeciesFixture(dataDir(), 1);
    DataLoader.resetForTests();
  });

  it('should load data successfully', async () => {
    await dataLoader.load(undefined, { dir: dataDir() });
    const sets = dataLoader.getSets();
    expect(sets).toBeDefined();
    expect(sets.Pikachu).toBeDefined();
  });

  it('should get species stats', async () => {
    await dataLoader.load(undefined, { dataDir: dataDir() });
    const stats = dataLoader.getSpeciesStats('Pikachu');
    expect(stats).toBeDefined();
    expect(stats?.level).toBe(88);
  });

  it('should throw if not loaded', () => {
    const freshLoader = Object.create(Object.getPrototypeOf(dataLoader));
    expect(() => freshLoader.getSets()).toThrow();
  });

  it('does not write data/gen9-stats.json', () => {
    const after = fs.existsSync(canonicalStats) ? fs.readFileSync(canonicalStats) : null;
    expect(after).toEqual(canonicalBefore);
    expect(dataDir()).not.toBe(path.join(process.cwd(), 'data'));
  });

  it('prints a stable species count and hash', () => {
    const manifest = readDataManifest(dataDir());
    expect(manifest.species).toBe(1);
    expect(manifest.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(formatDataLine(manifest)).toBe(`data species=1 hash=${manifest.hash}`);
    expect(readDataManifest(dataDir()).hash).toBe(manifest.hash);
  });

  it('refuses a short table unless the caller sets the test-only flag', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-floor-'));
    writeSpeciesFixture(dir, 1);
    const loader = DataLoader.isolated();
    await expect(loader.load(undefined, { dir, allowSmall: false })).rejects.toThrow(/minimum 500/);
  });

  it('accepts a table at the species floor', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-floor-'));
    writeSpeciesFixture(dir, MIN_SPECIES);
    const manifest = await DataLoader.isolated().load(undefined, { dir, allowSmall: false });
    expect(manifest.species).toBe(MIN_SPECIES);
  });
});
