import { describe, it, expect, beforeAll } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataLoader, dataLoader } from './data-loader.js';

const canonicalStats = path.join(process.cwd(), 'data', 'gen9-stats.json');
const canonicalBefore = fs.existsSync(canonicalStats) ? fs.readFileSync(canonicalStats) : null;

describe('DataLoader', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-data-loader-'));

  beforeAll(() => {
    fs.writeFileSync(
      path.join(dataDir, 'gen9-sets.json'),
      JSON.stringify({ Pikachu: { level: 88 } })
    );

    fs.writeFileSync(
      path.join(dataDir, 'gen9-stats.json'),
      JSON.stringify({
        Pikachu: {
          level: 88,
          abilities: { Static: 1.0 },
          items: { 'Light Ball': 1.0 },
          roles: {
            'Fast Attacker': {
              weight: 1.0,
              moves: { Thunderbolt: 1.0, 'Volt Switch': 0.8 },
            },
          },
        },
      })
    );
    DataLoader.resetForTests();
  });

  it('should load data successfully', async () => {
    await dataLoader.load(undefined, { dataDir });
    const sets = dataLoader.getSets();
    expect(sets).toBeDefined();
    expect(sets.Pikachu).toBeDefined();
  });

  it('should get species stats', async () => {
    await dataLoader.load(undefined, { dataDir });
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
    expect(dataDir).not.toBe(path.join(process.cwd(), 'data'));
  });
});
