import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startRandomBattle, teamsForSeed } from '../engine/exact/battle-utils.js';
import { HELD_OUT_PERCENT, generatePositions, minePosition, splitFor } from './positions.js';

describe('position splits', () => {
  it('holds out about 20 percent and is stable', () => {
    let held = 0;
    const n = 400;
    for (let i = 0; i < n; i++) {
      const id = `pos-${i}`;
      expect(splitFor(id)).toBe(splitFor(id));
      if (splitFor(id) === 'held-out') held++;
    }
    expect(held / n).toBeGreaterThan(0.1);
    expect(held / n).toBeLessThan(0.3);
    expect(HELD_OUT_PERCENT).toBe(20);
  });

  it('refuses a 1-ply label', () => {
    expect(() => generatePositions({ games: 1, labelDepth: 1, maxPositions: 1 })).toThrow(/deeper/);
  });

  it('labels a generated position with a deeper exact search and hashes the split', () => {
    const records = generatePositions({ games: 1, seedStart: 2, maxPositions: 1, labelDepth: 2 });
    expect(records.length).toBe(1);
    expect(records[0].labelDepth).toBe(2);
    expect(records[0].source).toBe('generated');
    expect(records[0].label.length).toBeGreaterThan(0);
    expect(records[0].split).toBe(splitFor(records[0].id));
  }, 120000);

  it('mines without letting the caller pick the split', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-'));
    const file = path.join(dir, 'pool.json');
    const teams = teamsForSeed(2);
    const battle = startRandomBattle(teams.p1, teams.p2, 2);
    const record = minePosition({ battle, side: 'p1', seed: 2, labelDepth: 2, outPath: file });
    expect(record.source).toBe('mined');
    expect(record.split).toBe(splitFor(record.id));
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<{ id: string; split: string }>;
    expect(saved.find(row => row.id === record.id)?.split).toBe(splitFor(record.id));
    const source = fs.readFileSync(path.join(process.cwd(), 'src/config/positions.ts'), 'utf8');
    const signature = source.slice(source.indexOf('export function minePosition'), source.indexOf('export async function agreement'));
    expect(signature).not.toMatch(/split\??:/);
  }, 120000);
});
