import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const require = createRequire(import.meta.url);
const { snapshotDataTree, diffDataTrees } = require('../../scripts/data-guard.cjs') as {
  snapshotDataTree: (dir: string) => Record<string, string>;
  diffDataTrees: (before: Record<string, string>, after: Record<string, string>) => string[];
};

describe('data guard', () => {
  it('reports added, changed, and removed files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-data-guard-'));
    fs.writeFileSync(path.join(dir, 'gen9-stats.json'), '{"Pikachu":{}}\n');
    const before = snapshotDataTree(dir);
    fs.writeFileSync(path.join(dir, 'gen9-stats.json'), '{"Pikachu":{"level":1}}\n');
    fs.writeFileSync(path.join(dir, 'extra.json'), '{}\n');
    const changed = diffDataTrees(before, snapshotDataTree(dir));
    expect(changed).toEqual(['added extra.json', 'changed gen9-stats.json']);

    fs.rmSync(path.join(dir, 'gen9-stats.json'));
    expect(diffDataTrees(before, snapshotDataTree(dir))).toEqual([
      'added extra.json',
      'removed gen9-stats.json',
    ]);
  });

  it('treats a missing directory as an empty tree', () => {
    const missing = path.join(os.tmpdir(), `jev-data-guard-missing-${process.pid}`);
    expect(snapshotDataTree(missing)).toEqual({});
    expect(diffDataTrees({}, {})).toEqual([]);
  });
});
