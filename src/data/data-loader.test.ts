import { describe, it, expect, beforeAll } from '@jest/globals';
import { dataLoader } from './data-loader.js';
import * as fs from 'fs';
import * as path from 'path';

describe('DataLoader', () => {
  beforeAll(() => {
    const dataDir = path.join(process.cwd(), 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    
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
  });

  it('should load data successfully', async () => {
    await dataLoader.load();
    const sets = dataLoader.getSets();
    expect(sets).toBeDefined();
    expect(sets.Pikachu).toBeDefined();
  });

  it('should get species stats', async () => {
    await dataLoader.load();
    const stats = dataLoader.getSpeciesStats('Pikachu');
    expect(stats).toBeDefined();
    expect(stats?.level).toBe(88);
  });

  it('should throw if not loaded', () => {
    const freshLoader = Object.create(Object.getPrototypeOf(dataLoader));
    expect(() => freshLoader.getSets()).toThrow();
  });
});
