import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findDrainFile, LiveDrain, shouldFinishSeries, watchDrainFiles } from './drain.js';

describe('live drain', () => {
  it('finishes when the request is met or when a drain has no active games', () => {
    expect(shouldFinishSeries({ finished: 1, requested: 4, draining: false, active: 1 })).toBe(false);
    expect(shouldFinishSeries({ finished: 4, requested: 4, draining: false, active: 1 })).toBe(false);
    expect(shouldFinishSeries({ finished: 4, requested: 4, draining: false, active: 0 })).toBe(true);
    expect(shouldFinishSeries({ finished: 1, requested: 4, draining: true, active: 2 })).toBe(false);
    expect(shouldFinishSeries({ finished: 1, requested: 4, draining: true, active: 0 })).toBe(true);
  });

  it('requests drain once and notifies listeners already waiting', () => {
    const drain = new LiveDrain();
    const reasons: string[] = [];
    drain.onDrain(reason => reasons.push(reason));
    drain.request('SIGTERM');
    drain.request('SIGUSR1');
    drain.onDrain(reason => reasons.push(`late:${reason}`));
    expect(drain.isDraining).toBe(true);
    expect(drain.drainReason).toBe('SIGTERM');
    expect(reasons).toEqual(['SIGTERM', 'late:SIGTERM']);
  });

  it('notices a drain file that appears after the watch starts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-drain-'));
    const file = path.join(dir, 'run.drain');
    const hits: string[] = [];
    const watch = watchDrainFiles([file], found => hits.push(found), 20);
    expect(findDrainFile([file])).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(hits).toEqual([]);
    fs.writeFileSync(file, '');
    await new Promise(resolve => setTimeout(resolve, 50));
    watch.stop();
    expect(hits).toEqual([file]);
  });

  it('drains immediately when the file is already present', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-drain-'));
    const file = path.join(dir, 'DRAIN');
    fs.writeFileSync(file, '');
    const hits: string[] = [];
    const watch = watchDrainFiles([file], found => hits.push(found), 1000);
    watch.stop();
    expect(hits).toEqual([file]);
  });
});
