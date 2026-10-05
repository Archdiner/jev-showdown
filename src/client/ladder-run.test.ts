import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { publicAccountConflict, readLadderRuns, writeLadderRun } from './ladder-run.js';

describe('public ladder account lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-ladder-runs-'));

  it('refuses the same account, warns when the username was not recorded, and ignores local or dead batches', () => {
    writeLadderRun(dir, { runId: 'same', pid: 11, username: 'Jev Bot', local: false, engine: 'search' });
    writeLadderRun(dir, { runId: 'other', pid: 12, username: 'otherbot', local: false, engine: 'search' });
    writeLadderRun(dir, { runId: 'local', pid: 13, username: 'jevbot', local: true, engine: 'search' });
    writeLadderRun(dir, { runId: 'dead', pid: 14, username: 'jevbot', local: false, engine: 'search' });
    writeLadderRun(dir, { runId: 'legacy', pid: 15, engine: 'search', local: false });
    const runs = readLadderRuns(dir);
    const alive = (pid: number) => pid !== 14;

    expect(publicAccountConflict('jevbot', runs, alive)).toMatchObject({
      action: 'refuse',
    });
    expect(publicAccountConflict('jevbot', runs, alive)?.message).toContain('pid 11');
    expect(publicAccountConflict('someoneelse', runs.filter(run => run.runId !== 'legacy'), alive)).toBeNull();
    expect(publicAccountConflict('someoneelse', runs, alive)).toMatchObject({ action: 'warn' });
    expect(publicAccountConflict('jevbot', runs, () => false)).toBeNull();
  });
});
