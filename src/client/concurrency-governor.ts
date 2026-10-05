import { EventEmitter } from 'events';
import type { LadderQueue } from './ladder-queue.js';

export type PressureKind = 'latency' | 'timer' | 'throttle';

export interface GovernorEvent {
  type: 'pause' | 'resume' | 'ramp' | 'backoff';
  from: number;
  to: number;
  pressure: PressureKind[];
  reason: string;
}

export interface AdmissionSettings {
  initial: number;
  target: number;
  ramp: boolean;
  step: number;
  healthyDecisions: number;
  latencyP95Ms: number;
  resumeLatencyP95Ms: number;
  timerMarginSec: number;
  resumeTimerMarginSec: number;
  window: number;
  minSamples: number;
  throttleCooldownMs: number;
}

export interface DecisionSample {
  battleId: string;
  latencyMs: number;
  secondsLeft: number | null;
}

/**
 * Search stays at `concurrency` unless `--ramp` is set.
 * Healthy 1-ply play at concurrency 3 is about 190ms p99, so 800ms is the trip.
 * Grok calls are about 25s, so that profile does not ramp and trips only past 60s.
 */
export function admissionSettings(input: {
  engine: string;
  concurrency: number;
  ramp: boolean;
  rampFrom?: number | null;
  rampTarget?: number | null;
}): AdmissionSettings {
  const engine = input.engine.trim().toLowerCase();
  const grok = engine === 'grok' || engine === 'llm' || engine === 'hybrid';
  const ceiling = Math.max(1, Math.floor(input.concurrency));
  const requested = input.rampTarget == null ? ceiling : Math.floor(input.rampTarget);
  const target = Math.max(1, Math.min(requested, ceiling));
  const ramp = grok ? false : input.ramp;
  const preset = grok ? 1 : engine === 'max-damage' ? 4 : 3;
  const initial = ramp ? Math.max(1, Math.min(input.rampFrom ?? preset, target)) : target;
  const slow = grok;
  const fast = engine === 'max-damage';
  return {
    initial,
    target: ramp ? Math.max(initial, target) : initial,
    ramp,
    step: 1,
    healthyDecisions: fast ? 8 : grok ? 20 : 12,
    latencyP95Ms: slow ? 60_000 : fast ? 400 : 800,
    resumeLatencyP95Ms: slow ? 40_000 : fast ? 200 : 400,
    timerMarginSec: slow ? 45 : fast ? 12 : 15,
    resumeTimerMarginSec: slow ? 70 : fast ? 20 : 25,
    window: slow ? 8 : 20,
    minSamples: slow ? 3 : 5,
    throttleCooldownMs: slow ? 20_000 : 15_000,
  };
}

/**
 * Raises or pauses the number of new searches. Never represents cancelling a game.
 * While paused, `allowsNewSearch` is false and `admissionLimit` equals games already active.
 */
export class ConcurrencyGovernor {
  private level: number;
  private readonly latencies: number[] = [];
  private readonly timers = new Map<string, number>();
  private paused = false;
  private pressure: PressureKind[] = [];
  private healthyDecisions = 0;
  private throttleUntil = 0;
  private backedOff = false;
  private throttleCount = 0;

  constructor(
    private readonly settings: AdmissionSettings,
    private readonly now: () => number = Date.now,
  ) {
    this.level = settings.initial;
  }

  get currentLevel(): number {
    return this.level;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get currentPressure(): PressureKind[] {
    return [...this.pressure];
  }

  get throttleEvents(): number {
    return this.throttleCount;
  }

  throttleRemaining(at = this.now()): number {
    return Math.max(0, this.throttleUntil - at);
  }

  admissionLimit(activeGames: number): number {
    const active = Math.max(0, Math.floor(activeGames));
    return this.paused ? active : this.level;
  }

  allowsNewSearch(activeGames: number): boolean {
    return !this.paused && activeGames < this.level;
  }

  recordDecision(sample: DecisionSample): GovernorEvent[] {
    this.latencies.push(sample.latencyMs);
    while (this.latencies.length > this.settings.window) this.latencies.shift();
    if (sample.secondsLeft !== null) this.timers.set(sample.battleId, sample.secondsLeft);
    return this.evaluate();
  }

  forgetBattle(battleId: string): GovernorEvent[] {
    this.timers.delete(battleId);
    return this.evaluate();
  }

  recordThrottle(at = this.now()): GovernorEvent[] {
    this.throttleCount += 1;
    this.throttleUntil = at + this.settings.throttleCooldownMs;
    return this.evaluate();
  }

  poll(): GovernorEvent[] {
    return this.evaluate();
  }

  private evaluate(): GovernorEvent[] {
    const next = this.reasons();
    const events: GovernorEvent[] = [];
    if (next.length > 0) {
      if (!this.paused) {
        this.paused = true;
        this.backedOff = false;
        this.healthyDecisions = 0;
        events.push({ type: 'pause', from: this.level, to: this.level, pressure: next, reason: next.join(',') });
      }
      if (!this.backedOff && this.settings.ramp) {
        this.backedOff = true;
        const from = this.level;
        const to = Math.max(1, from - this.settings.step);
        this.level = to;
        if (to !== from) {
          events.push({ type: 'backoff', from, to, pressure: next, reason: next.join(',') });
        }
      }
      this.pressure = next;
      return events;
    }

    if (this.paused) {
      this.paused = false;
      this.backedOff = false;
      this.healthyDecisions = 0;
      events.push({ type: 'resume', from: this.level, to: this.level, pressure: [], reason: 'healthy' });
    }
    this.pressure = [];
    if (this.settings.ramp && this.latencies.length >= this.settings.minSamples) {
      this.healthyDecisions += 1;
      if (this.healthyDecisions >= this.settings.healthyDecisions && this.level < this.settings.target) {
        const from = this.level;
        const to = Math.min(this.settings.target, from + this.settings.step);
        this.level = to;
        this.healthyDecisions = 0;
        events.push({ type: 'ramp', from, to, pressure: [], reason: 'healthy' });
      }
    }
    return events;
  }

  private reasons(): PressureKind[] {
    const reasons: PressureKind[] = [];
    const settings = this.settings;
    if (this.latencies.length >= settings.minSamples) {
      const p95 = percentile(this.latencies, 95);
      const held = this.paused && this.pressure.includes('latency');
      const limit = held ? settings.resumeLatencyP95Ms : settings.latencyP95Ms;
      if (p95 > limit) reasons.push('latency');
    }
    if (this.timers.size > 0) {
      const margin = Math.min(...this.timers.values());
      const held = this.paused && this.pressure.includes('timer');
      const limit = held ? settings.resumeTimerMarginSec : settings.timerMarginSec;
      if (margin < limit) reasons.push('timer');
    }
    if (this.now() < this.throttleUntil) reasons.push('throttle');
    return reasons;
  }
}

export class SearchAdmission {
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly queues: LadderQueue[] = [];

  constructor(private readonly governor: ConcurrencyGovernor) {}

  watch(input: { queue: LadderQueue; driver: EventEmitter }): void {
    this.queues.push(input.queue);
    input.driver.on('decision', (sample: DecisionSample) => {
      this.apply(this.governor.recordDecision(sample));
    });
    input.driver.on('gameEnd', (summary: { battleId: string }) => {
      this.apply(this.governor.forgetBattle(summary.battleId));
    });
    this.sync();
  }

  noteThrottle(message: string): void {
    console.warn(`[ladder] backpressure throttle: ${message}`);
    this.apply(this.governor.recordThrottle());
    this.arm();
  }

  private apply(events: GovernorEvent[]): void {
    for (const event of events) {
      console.log(`[ladder] ${event.type} concurrency ${event.from}->${event.to} (${event.reason})`);
    }
    this.sync();
  }

  private sync(): void {
    const paused = this.governor.isPaused;
    for (const queue of this.queues) {
      if (paused) queue.pauseSearches();
      else queue.resumeSearches();
      queue.setLimit(this.governor.admissionLimit(queue.activeBattles));
    }
  }

  private arm(): void {
    if (this.pollTimer) return;
    const wait = this.governor.throttleRemaining();
    if (wait <= 0) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.apply(this.governor.poll());
      this.arm();
    }, wait);
  }

  stop(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}
