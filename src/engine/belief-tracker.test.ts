import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { BeliefTracker } from './belief-tracker.js';
import { DataLoader } from '../data/data-loader.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { RandbatsStats } from '../types/index.js';

describe('BeliefTracker', () => {
  let testDir: string;
  let stats: RandbatsStats;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'belief-tracker-test-'));
    fs.writeFileSync(path.join(testDir, 'gen9-sets.json'), JSON.stringify({}));
    fs.writeFileSync(
      path.join(testDir, 'gen9-stats.json'),
      JSON.stringify({
        Pikachu: {
          level: 88,
          abilities: { Static: 0.9, 'Lightning Rod': 0.1 },
          items: { 'Light Ball': 1.0 },
          roles: {
            'Fast Attacker': {
              weight: 0.8,
              moves: { Thunderbolt: 1.0, 'Volt Switch': 0.8 },
              items: { 'Light Ball': 1.0 },
            },
            Wallbreaker: {
              weight: 0.2,
              moves: { Thunderbolt: 1.0, Surf: 0.5 },
              items: { 'Light Ball': 1.0 },
            },
          },
        },
      }),
    );
    const loader = new DataLoader(testDir);
    await loader.load();
    stats = loader.getStats();
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should initialize belief with role probabilities', () => {
    const tracker = new BeliefTracker(stats);
    const belief = tracker.initializeBelief('p1-pikachu', 'Pikachu', 88);
    expect(belief.species).toBe('Pikachu');
    expect(belief.level).toBe(88);
    expect(belief.possibleSets.size).toBeGreaterThan(0);
  });

  it('should update belief on move reveal', () => {
    const tracker = new BeliefTracker(stats);
    tracker.initializeBelief('p1-pikachu', 'Pikachu', 88);
    tracker.updateOnMove('p1-pikachu', 'Volt Switch');
    const belief = tracker.getBelief('p1-pikachu');
    expect(belief?.revealedMoves.has('Volt Switch')).toBe(true);
  });

  it('should sample a role from beliefs', () => {
    const tracker = new BeliefTracker(stats);
    tracker.initializeBelief('p1-pikachu', 'Pikachu', 88);
    const role = tracker.sampleRole('p1-pikachu');
    expect(role).toBeTruthy();
  });
});
