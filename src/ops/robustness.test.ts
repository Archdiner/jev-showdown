import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { jest } from '@jest/globals';
import { runAnalyst } from './analyst.js';
import { appendJsonl, consumeJsonl, JSONL_LINE_MAX, opsPaths } from './paths.js';
import { restartPlan, supervise } from './supervisor.js';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jev-robust-'));
}

describe('jsonl tail', () => {
  test('a long record is capped and a torn line is not consumed', async () => {
    const buf = Buffer.from('{"a":1}\n{bad\n{"b":');
    const parsed = consumeJsonl(buf);
    expect(parsed.records).toEqual([{ a: 1 }]);
    expect(parsed.corrupt).toBe(1);
    expect(parsed.bytes).toBe(Buffer.byteLength('{"a":1}\n{bad\n'));

    const root = tempRoot();
    const priorOps = process.env.OPS_DIR;
    const priorGraph = process.env.GRAPH_DB;
    const savedKey = process.env.VERCEL_AI_GATEWAY_KEY;
    const savedAlt = process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_AI_GATEWAY_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    process.env.OPS_DIR = root;
    process.env.GRAPH_DB = path.join(root, 'graph.db');
    const paths = opsPaths(root);
    try {
      appendJsonl(paths.liveGames, { id: 'huge', inputLog: 'a'.repeat(20_000), log: 'b'.repeat(20_000) });
      const capped = fs.readFileSync(paths.liveGames);
      expect(capped.length).toBeLessThanOrEqual(JSONL_LINE_MAX);
      const row = JSON.parse(capped.toString('utf8')) as { truncated?: boolean; id?: string };
      expect(row.truncated).toBe(true);
      expect(row.id).toBe('huge');

      fs.writeFileSync(paths.liveGames, '{"id":"ok","winner":"win"}\n{bad\n{"id":"tail"');
      fs.writeFileSync(paths.analystOffset, '0');
      expect(await runAnalyst(paths, { once: true })).toBe(1);
      const offset = Number(fs.readFileSync(paths.analystOffset, 'utf8'));
      expect(offset).toBe(Buffer.byteLength('{"id":"ok","winner":"win"}\n{bad\n'));
      expect(fs.readFileSync(paths.heartbeats, 'utf8')).toContain('log-corrupt');

      fs.appendFileSync(paths.liveGames, ',"winner":"loss"}\n');
      expect(await runAnalyst(paths, { once: true })).toBe(1);
    } finally {
      if (priorOps === undefined) delete process.env.OPS_DIR;
      else process.env.OPS_DIR = priorOps;
      if (priorGraph === undefined) delete process.env.GRAPH_DB;
      else process.env.GRAPH_DB = priorGraph;
      if (savedKey === undefined) delete process.env.VERCEL_AI_GATEWAY_KEY;
      else process.env.VERCEL_AI_GATEWAY_KEY = savedKey;
      if (savedAlt === undefined) delete process.env.AI_GATEWAY_API_KEY;
      else process.env.AI_GATEWAY_API_KEY = savedAlt;
    }
  });
});

describe('supervisor restarts', () => {
  test('the plan restarts forever with a capped backoff', () => {
    expect(restartPlan(0, 4)).toEqual({ action: 'done', delayMs: 0 });
    expect(restartPlan(1, 0)).toEqual({ action: 'restart', delayMs: 500 });
    expect(restartPlan(1, 2)).toEqual({ action: 'restart', delayMs: 2_000 });
    expect(restartPlan(null, 3).action).toBe('restart');
    expect(restartPlan(1, 20).delayMs).toBe(30_000);
  });

  test('three crashes still restart, and a spawn error exits non-zero', async () => {
    jest.useFakeTimers();
    const priorCode = process.exitCode;
    const root = tempRoot();
    const priorOps = process.env.OPS_DIR;
    const priorGraph = process.env.GRAPH_DB;
    process.env.OPS_DIR = root;
    process.env.GRAPH_DB = path.join(root, 'graph.db');
    try {
      let spawned = 0;
      const pending: EventEmitter[] = [];
      const done = supervise({
        spawnImpl: () => {
          spawned += 1;
          const child = new EventEmitter();
          pending.push(child);
          return child as never;
        },
      });
      expect(spawned).toBe(4);
      for (let round = 0; round < 3; round++) {
        const batch = pending.splice(0, pending.length);
        expect(batch).toHaveLength(4);
        for (const child of batch) child.emit('exit', 1);
        await jest.advanceTimersByTimeAsync(restartPlan(1, round).delayMs);
      }
      expect(spawned).toBe(16);
      for (const child of pending.splice(0)) child.emit('exit', 0);
      await done;

      process.exitCode = undefined;
      const failed: EventEmitter[] = [];
      const abandoned = supervise({
        spawnImpl: () => {
          const child = new EventEmitter();
          failed.push(child);
          return child as never;
        },
      });
      for (const child of failed) child.emit('error', new Error('spawn ENOENT'));
      await abandoned;
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = priorCode;
      jest.useRealTimers();
      if (priorOps === undefined) delete process.env.OPS_DIR;
      else process.env.OPS_DIR = priorOps;
      if (priorGraph === undefined) delete process.env.GRAPH_DB;
      else process.env.GRAPH_DB = priorGraph;
    }
  });
});
