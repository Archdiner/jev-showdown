import { EventEmitter } from 'events';
import { jest } from '@jest/globals';
import { ConcurrencyGovernor, SearchAdmission, admissionSettings, type AdmissionSettings } from './concurrency-governor.js';
import { LadderQueue } from './ladder-queue.js';
import type { ShowdownClient } from './showdown-client.js';

function settings(overrides: Partial<AdmissionSettings> = {}): AdmissionSettings {
  return {
    initial: 1,
    target: 8,
    ramp: true,
    step: 1,
    healthyDecisions: 2,
    latencyP95Ms: 800,
    resumeLatencyP95Ms: 400,
    timerMarginSec: 15,
    resumeTimerMarginSec: 25,
    window: 10,
    minSamples: 4,
    throttleCooldownMs: 1_000,
    ...overrides,
  };
}

function fast(governor: ConcurrencyGovernor, battleId: string, n: number, secondsLeft: number | null = 100): void {
  for (let i = 0; i < n; i++) {
    governor.recordDecision({ battleId, latencyMs: 100, secondsLeft });
  }
}

describe('search admission', () => {
  it('ramps toward the target while decisions stay fast', () => {
    const governor = new ConcurrencyGovernor(settings({ minSamples: 1 }));
    fast(governor, 'b', 2);
    expect(governor.currentLevel).toBe(2);
    expect(governor.allowsNewSearch(1)).toBe(true);
    expect(governor.allowsNewSearch(2)).toBe(false);
    fast(governor, 'b', 2);
    expect(governor.currentLevel).toBe(3);
  });

  it('pauses and backs off once when p95 latency degrades, then resumes lower', () => {
    const governor = new ConcurrencyGovernor(settings({
      initial: 4,
      target: 8,
      window: 4,
      minSamples: 4,
      healthyDecisions: 100,
    }));
    const trip = [
      governor.recordDecision({ battleId: 'b', latencyMs: 5_000, secondsLeft: 100 }),
      governor.recordDecision({ battleId: 'b', latencyMs: 5_000, secondsLeft: 100 }),
      governor.recordDecision({ battleId: 'b', latencyMs: 5_000, secondsLeft: 100 }),
      governor.recordDecision({ battleId: 'b', latencyMs: 5_000, secondsLeft: 100 }),
    ].flat();
    expect(trip.map(event => event.type)).toEqual(['pause', 'backoff']);
    expect(governor.isPaused).toBe(true);
    expect(governor.currentLevel).toBe(3);
    expect(governor.allowsNewSearch(0)).toBe(false);
    expect(governor.admissionLimit(2)).toBe(2);
    governor.recordDecision({ battleId: 'b', latencyMs: 5_000, secondsLeft: 100 });
    expect(governor.currentLevel).toBe(3);
    fast(governor, 'b', 4, 100);
    expect(governor.isPaused).toBe(false);
    expect(governor.currentLevel).toBe(3);
    expect(governor.allowsNewSearch(2)).toBe(true);
  });

  it('holds pause until every active game is above the timer resume margin', () => {
    const governor = new ConcurrencyGovernor(settings({ ramp: false, initial: 3, target: 3 }));
    governor.recordDecision({ battleId: 'tight', latencyMs: 50, secondsLeft: 10 });
    expect(governor.currentPressure).toEqual(['timer']);
    expect(governor.currentLevel).toBe(3);
    governor.recordDecision({ battleId: 'fine', latencyMs: 50, secondsLeft: 140 });
    expect(governor.isPaused).toBe(true);
    governor.recordDecision({ battleId: 'tight', latencyMs: 50, secondsLeft: 20 });
    expect(governor.isPaused).toBe(true);
    governor.forgetBattle('tight');
    expect(governor.isPaused).toBe(false);
  });

  it('pauses on a throttle and resumes only after the cooldown', () => {
    let now = 1_000;
    const governor = new ConcurrencyGovernor(settings({ ramp: false, initial: 2, target: 2 }), () => now);
    const events = governor.recordThrottle();
    expect(events[0].type).toBe('pause');
    expect(governor.allowsNewSearch(0)).toBe(false);
    now += 500;
    expect(governor.poll().map(event => event.type)).toEqual([]);
    expect(governor.isPaused).toBe(true);
    now += 500;
    expect(governor.poll().map(event => event.type)).toEqual(['resume']);
    expect(governor.allowsNewSearch(1)).toBe(true);
  });

  it('stops the ramp at the target', () => {
    const governor = new ConcurrencyGovernor(settings({ initial: 7, target: 8, healthyDecisions: 1, minSamples: 1 }));
    fast(governor, 'b', 1);
    expect(governor.currentLevel).toBe(8);
    fast(governor, 'b', 3);
    expect(governor.currentLevel).toBe(8);
  });

  it('builds a search ramp of 3 toward the requested ceiling and keeps grok at 1', () => {
    const search = admissionSettings({ engine: 'search', concurrency: 10, ramp: true });
    expect(search.initial).toBe(3);
    expect(search.target).toBe(10);
    expect(search.latencyP95Ms).toBe(800);
    const capped = admissionSettings({ engine: 'search', concurrency: 5, ramp: false });
    expect(capped.initial).toBe(5);
    expect(capped.ramp).toBe(false);
    const grok = admissionSettings({ engine: 'grok', concurrency: 1, ramp: true });
    expect(grok).toMatchObject({ initial: 1, target: 1, ramp: false, latencyP95Ms: 60_000 });
  });
});

describe('queue backpressure', () => {
  it('pauses new searches and leaves the active game in place', () => {
    jest.useFakeTimers({ now: 20_000 });
    try {
      const searches: string[] = [];
      let cancels = 0;
      const client = {
        isReady: () => true,
        isBlocked: () => false,
        search: (format: string) => {
          searches.push(format);
          return true;
        },
        cancelSearch: () => {
          cancels += 1;
          return true;
        },
      } as unknown as ShowdownClient;
      const queue = new LadderQueue(client, 'gen9randombattle', 3, () => {}, true);
      const driver = new EventEmitter();
      const governor = new ConcurrencyGovernor(settings({
        initial: 3,
        target: 3,
        ramp: true,
        minSamples: 2,
        healthyDecisions: 100,
        throttleCooldownMs: 5_000,
      }), () => Date.now());
      const admission = new SearchAdmission(governor);
      admission.watch({ queue, driver });
      queue.fill();
      expect(searches).toEqual(['gen9randombattle']);
      queue.noteBattle('battle-1');
      driver.emit('decision', { battleId: 'battle-1', latencyMs: 5_000, secondsLeft: 100 });
      driver.emit('decision', { battleId: 'battle-1', latencyMs: 5_000, secondsLeft: 100 });
      expect(queue.activeBattles).toBe(1);
      expect(cancels).toBeGreaterThan(0);
      const started = searches.length;
      queue.fill();
      jest.advanceTimersByTime(1_000);
      expect(searches.length).toBe(started);
      admission.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});
