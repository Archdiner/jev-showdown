import * as fs from 'fs';
import * as path from 'path';
import { LiveDrain } from './drain.js';
import {
  createLadderSeries,
  DEFAULT_SERIES_IDLE_MS,
  isBattleActivity,
  type BatchEndReason,
} from './series-run.js';

/**
 * The deadline INC-024 hit: 3 minutes per wave of `concurrency` games, and at
 * least 5 minutes. 30 games at concurrency 3 is 10 waves, which is 30 minutes.
 */
function legacyBatchDeadlineMs(games: number, concurrency: number): number {
  const waves = Math.ceil(games / Math.max(1, concurrency));
  return Math.max(300_000, waves * 180_000);
}

interface Clock {
  advance(ms: number): void;
  readonly elapsed: number;
  schedule(fn: () => void, ms: number): () => void;
}

function fakeClock(): Clock {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  return {
    get elapsed() {
      return now;
    },
    schedule(fn, ms) {
      const timer = { at: now + ms, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = timers
          .filter(timer => !timer.cancelled && timer.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        next.cancelled = true;
        next.fn();
      }
      now = target;
    },
  };
}

function harness(input: { games: number; idleMs: number; active: number }) {
  const clock = fakeClock();
  let active = input.active;
  const calls: string[] = [];
  const drain = new LiveDrain();
  const series = createLadderSeries<{ battleId: string }>({
    games: input.games,
    idleMs: input.idleMs,
    drain,
    activeGames: () => active,
    stopSearching: () => calls.push('stop-search'),
    fill: () => calls.push('fill'),
    onSettle: () => calls.push('settle'),
    schedule: clock.schedule,
    log: () => {},
    warn: () => {},
  });
  return {
    clock,
    drain,
    series,
    calls,
    setActive(count: number) {
      active = count;
    },
  };
}

describe('ladder batch idle watchdog', () => {
  it('a slow batch that keeps progressing completes past the old wall-clock deadline', async () => {
    const deadline = legacyBatchDeadlineMs(30, 3);
    expect(deadline).toBe(30 * 60 * 1000);
    const stepMs = 4 * 60 * 1000;
    const run = harness({ games: 30, idleMs: DEFAULT_SERIES_IDLE_MS, active: 3 });
    run.series.start();

    for (let index = 0; index < 30; index++) {
      run.clock.advance(stepMs);
      run.series.noteActivity();
      run.setActive(index === 29 ? 0 : 3);
      run.series.finish({ battleId: `battle-${index}` });
    }

    expect(run.clock.elapsed).toBe(30 * stepMs);
    expect(run.clock.elapsed).toBeGreaterThan(deadline);
    expect(run.drain.isDraining).toBe(false);
    expect(run.series.endReason).toBe('completed');
    const outcome = await run.series.result;
    expect(outcome.endReason).toBe('completed');
    expect(outcome.games).toHaveLength(30);
    expect(run.calls).toContain('settle');
    expect(run.calls.filter(call => call === 'stop-search')).toEqual(['stop-search']);
  });

  it('a stalled batch drains in-flight games and ends stalled', async () => {
    const idleMs = 10 * 60 * 1000;
    const run = harness({ games: 30, idleMs, active: 3 });
    run.series.start();
    run.clock.advance(60_000);
    run.series.noteActivity();
    run.setActive(2);
    run.series.finish({ battleId: 'done-1' });

    run.clock.advance(idleMs);
    expect(run.drain.isDraining).toBe(true);
    expect(run.drain.drainReason).toBe('stall');
    expect(run.calls).toContain('stop-search');
    expect(run.series.endReason).toBeNull();

    let resolved = false;
    const pending = run.series.result.then(value => {
      resolved = true;
      return value;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    run.setActive(1);
    run.series.finish({ battleId: 'live-1' });
    expect(run.series.endReason).toBeNull();
    run.setActive(0);
    run.series.finish({ battleId: 'live-2' });
    expect(run.series.endReason).toBe<BatchEndReason>('stalled');
    const outcome = await pending;
    expect(outcome.endReason).toBe('stalled');
    expect(outcome.games.map(game => game.battleId)).toEqual(['done-1', 'live-1', 'live-2']);
  });

  it('a user drain waits out the old 30 minute cap and ends drained', async () => {
    const run = harness({ games: 30, idleMs: DEFAULT_SERIES_IDLE_MS, active: 2 });
    run.series.start();
    run.drain.request('SIGTERM');
    expect(run.series.endReason).toBeNull();
    expect(run.drain.drainReason).toBe('SIGTERM');

    run.clock.advance(30 * 60 * 1000);
    expect(run.series.endReason).toBeNull();
    expect(run.drain.drainReason).toBe('SIGTERM');

    run.setActive(1);
    run.series.finish({ battleId: 'still-playing' });
    expect(run.series.endReason).toBeNull();
    run.setActive(0);
    run.series.finish({ battleId: 'last' });
    const outcome = await run.series.result;
    expect(outcome.endReason).toBe('drained');
    expect(outcome.games.map(game => game.battleId)).toEqual(['still-playing', 'last']);
  });

  it('battle activity inside the idle window does not stall the batch', () => {
    const idleMs = 10 * 60 * 1000;
    const run = harness({ games: 2, idleMs, active: 1 });
    run.series.start();
    run.clock.advance(idleMs - 1);
    expect(run.drain.isDraining).toBe(false);
    run.series.noteActivity();
    run.clock.advance(idleMs - 1);
    expect(run.drain.isDraining).toBe(false);
    expect(run.series.endReason).toBeNull();
  });

  it('the ladder client no longer rejects a batch on the per-wave wall clock', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/cli/ladder.ts'), 'utf8');
    expect(source).not.toContain('waves * 180000');
    expect(source).not.toContain('Timed out after');
    expect(source).toContain('createLadderSeries');
    expect(source).toContain('endReason');
  });

  it('counts a turn or a search update as activity and ignores a timestamp', () => {
    expect(isBattleActivity('|turn|12')).toBe(true);
    expect(isBattleActivity('|request|{"active":[]}')).toBe(true);
    expect(isBattleActivity('|updatesearch|{"searching":["gen9randombattle"]}')).toBe(true);
    expect(isBattleActivity('|-damage|p1a: Mon|20')).toBe(true);
    expect(isBattleActivity('|t:|1710000000')).toBe(false);
    expect(isBattleActivity('|-message|hello')).toBe(false);
  });
});
