import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { DataLoader } from './data-loader.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('DataLoader', () => {
  let testDir: string;
  let testLoader: DataLoader;

  beforeAll(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-loader-test-'));
    
    fs.writeFileSync(
      path.join(testDir, 'gen9-sets.json'),
      JSON.stringify({ Pikachu: { level: 88 } })
    );
    
    fs.writeFileSync(
      path.join(testDir, 'gen9-stats.json'),
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

    testLoader = new DataLoader(testDir);
  });

  afterAll(() => {
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should load data successfully', async () => {
    await testLoader.load();
    const sets = testLoader.getSets();
    expect(sets).toBeDefined();
    expect(sets.Pikachu).toBeDefined();
  });

  it('should get species stats', async () => {
    await testLoader.load();
    const stats = testLoader.getSpeciesStats('Pikachu');
    expect(stats).toBeDefined();
    expect(stats?.level).toBe(88);
  });

  it('should throw if not loaded', () => {
    const freshLoader = new DataLoader(testDir);
    expect(() => freshLoader.getSets()).toThrow();
  });
});
