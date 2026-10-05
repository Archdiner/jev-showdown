import * as fs from 'fs';
import * as path from 'path';
import { validateConfigs } from './validate.js';
import { tuningScore } from './objective.js';
import { ablationConfigs } from './mutate.js';
import { loadConfig } from '../config/load.js';

describe('tuning stays off the held-out split', () => {
  it('scores win rate plus dev agreement only', () => {
    expect(tuningScore.length).toBe(2);
    expect(tuningScore(0.5, 0.25, 1)).toBeCloseTo(0.75);
  });

  it('keeps sweep and ablation off the held-out loader', () => {
    const root = path.join(process.cwd(), 'src/exp');
    for (const file of ['sweep.ts', 'ablate.ts', 'devset.ts', 'play.ts', 'objective.ts']) {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      expect(text).not.toMatch(/heldOutPositions/);
      expect(text).not.toMatch(/checkGatekeeper/);
      expect(text).not.toMatch(/guardrail/);
    }
    const sweep = fs.readFileSync(path.join(root, 'sweep.ts'), 'utf8');
    expect(sweep).toMatch(/scoreDev/);
    expect(sweep).toMatch(/tuningScore/);
    const keeper = fs.readFileSync(path.join(root, 'gatekeeper.ts'), 'utf8');
    expect(keeper).toMatch(/heldOutPositions/);
  });

  it('validates the config tree', () => {
    const report = validateConfigs();
    expect(report.errors).toEqual([]);
    expect(report.ok.length).toBeGreaterThan(10);
  });

  it('drops ablations that do not change the strategy', () => {
    const champion = loadConfig(path.join(process.cwd(), 'configs/champion.yaml')).config;
    const rows = ablationConfigs(champion);
    expect(rows.every(row => row.config.policies.teraPolicy.id === 'off' || row.label !== 'teraPolicy' || row.config.name.includes('ablate'))).toBe(true);
    expect(rows.some(row => row.label.startsWith('weight.'))).toBe(true);
    expect(rows.some(row => row.label === 'teraPolicy')).toBe(false);
  });
});
