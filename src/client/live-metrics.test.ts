import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { LiveMetrics, percentile } from './live-metrics.js';

describe('live metrics', () => {
  it('uses nearest-rank percentiles', () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
    expect(percentile([10, 20, 30, 40], 99)).toBe(40);
  });

  it('writes decision, throttle, game, and run records', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-metrics-'));
    const filePath = path.join(dir, 'metrics.jsonl');
    const metrics = new LiveMetrics(filePath, {
      runId: 'run-1',
      engine: 'search',
      concurrency: 3,
      configId: 'champion-exact-1ply',
      configHash: 'policyhash',
      gitSha: 'abc123',
    });
    const driver = new EventEmitter();
    metrics.attach(driver);

    driver.emit('battleStart', 'battle-1');
    driver.emit('decision', {
      battleId: 'battle-1',
      turn: 1,
      latencyMs: 100,
      secondsLeft: 140,
      fallback: false,
    });
    driver.emit('decision', {
      battleId: 'battle-1',
      turn: 2,
      latencyMs: 400,
      secondsLeft: 12,
      fallback: false,
    });
    metrics.noteThrottle('Due to high load, you are limited to 5 games at the same time.');
    metrics.noteGame({ battleId: 'battle-1', turns: 2, outcome: 'win' });
    metrics.finish({ games: 1, requested: 4 });
    await metrics.close();

    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(lines.map(line => line.type)).toEqual(['decision', 'decision', 'throttle', 'game', 'run']);
    expect(lines[0]).toMatchObject({
      v: 1,
      runId: 'run-1',
      engine: 'search',
      battleId: 'battle-1',
      turn: 1,
      latencyMs: 100,
      secondsLeft: 140,
      concurrency: 3,
    });
    expect(lines[3]).toMatchObject({
      type: 'game',
      configId: 'champion-exact-1ply',
      configHash: 'policyhash',
      gitSha: 'abc123',
      decisions: 2,
      latencyP50Ms: 100,
      latencyP95Ms: 400,
      latencyP99Ms: 400,
      minTimerMarginSec: 12,
      throttleEvents: 1,
      outcome: 'win',
    });
    expect(lines[4]).toMatchObject({
      type: 'run',
      games: 1,
      requested: 4,
      decisions: 2,
      minTimerMarginSec: 12,
      throttleEvents: 1,
      latencyP99Ms: 400,
    });
  });
});