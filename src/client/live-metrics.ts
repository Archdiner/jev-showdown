import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

export const LIVE_METRICS_VERSION = 1;

/** Nearest-rank percentile. `sorted[ceil(p/100*n) - 1]`. Empty input is null. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  if (!Number.isFinite(p) || p <= 0 || p > 100) throw new Error('percentile p must be in (0, 100]');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export interface DecisionObservation {
  battleId: string;
  turn: number;
  latencyMs: number;
  secondsLeft: number | null;
  fallback: boolean;
}

interface OpenGame {
  latencies: number[];
  minTimer: number | null;
  throttles: number;
  configId?: string | null;
  configHash?: string | null;
  role?: string | null;
  share?: number | null;
}

/**
 * JSONL stream for an ops dashboard. One object per line.
 * The field list is documented in the README.
 */
export class LiveMetrics {
  private stream: fs.WriteStream;
  private closed = false;
  private readonly games = new Map<string, OpenGame>();
  private readonly latencies: number[] = [];
  private minTimer: number | null = null;
  private throttles = 0;

  constructor(
    readonly filePath: string,
    private readonly context: {
      runId: string;
      batchLabel?: string | null;
      hostname?: string;
      engine: string;
      concurrency: number;
      configId?: string | null;
      configHash?: string | null;
      gitSha?: string | null;
      ab?: Array<{ configId: string; role: string; share: number }>;
    },
  ) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.stream = fs.createWriteStream(filePath, { flags: 'a' });
  }

  attach(driver: EventEmitter): void {
    driver.on('battleStart', (battleId: string, route?: {
      configId?: string | null;
      configHash?: string | null;
      role?: string | null;
      share?: number | null;
    } | null) => {
      const game = this.open(battleId);
      if (!route) return;
      if (route.configId) game.configId = route.configId;
      if (route.configHash) game.configHash = route.configHash;
      if (route.role) game.role = route.role;
      if (typeof route.share === 'number') game.share = route.share;
    });
    driver.on('decision', (sample: DecisionObservation) => {
      this.recordDecision(sample);
    });
  }

  recordDecision(sample: DecisionObservation): void {
    const game = this.games.get(sample.battleId) ?? this.open(sample.battleId);
    game.latencies.push(sample.latencyMs);
    this.latencies.push(sample.latencyMs);
    if (sample.secondsLeft !== null) {
      game.minTimer = game.minTimer === null ? sample.secondsLeft : Math.min(game.minTimer, sample.secondsLeft);
      this.minTimer = this.minTimer === null ? sample.secondsLeft : Math.min(this.minTimer, sample.secondsLeft);
    }
    this.write({
      type: 'decision',
      battleId: sample.battleId,
      turn: sample.turn,
      latencyMs: sample.latencyMs,
      secondsLeft: sample.secondsLeft,
      fallback: sample.fallback,
      concurrency: this.context.concurrency,
    }, sample.battleId);
  }

  noteThrottle(message: string): void {
    this.throttles += 1;
    for (const game of this.games.values()) game.throttles += 1;
    this.write({
      type: 'throttle',
      message,
      concurrency: this.context.concurrency,
    });
  }

  noteGame(game: {
    battleId: string;
    turns: number;
    outcome: string;
    configId?: string | null;
    configHash?: string | null;
    role?: string | null;
    share?: number | null;
  }): void {
    const stats = this.games.get(game.battleId) ?? this.open(game.battleId);
    if (game.configId) stats.configId = game.configId;
    if (game.configHash) stats.configHash = game.configHash;
    if (game.role) stats.role = game.role;
    if (typeof game.share === 'number') stats.share = game.share;
    this.write({
      type: 'game',
      battleId: game.battleId,
      turns: game.turns,
      outcome: game.outcome,
      decisions: stats.latencies.length,
      latencyP50Ms: percentile(stats.latencies, 50),
      latencyP95Ms: percentile(stats.latencies, 95),
      latencyP99Ms: percentile(stats.latencies, 99),
      minTimerMarginSec: stats.minTimer,
      throttleEvents: stats.throttles,
    }, game.battleId);
    this.games.delete(game.battleId);
  }

  finish(input: { games: number; requested: number }): void {
    this.write({
      type: 'run',
      games: input.games,
      requested: input.requested,
      decisions: this.latencies.length,
      latencyP50Ms: percentile(this.latencies, 50),
      latencyP95Ms: percentile(this.latencies, 95),
      latencyP99Ms: percentile(this.latencies, 99),
      minTimerMarginSec: this.minTimer,
      throttleEvents: this.throttles,
      concurrency: this.context.concurrency,
      ...(this.context.ab ? { ab: this.context.ab } : {}),
    });
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return new Promise(resolve => {
      this.stream.end(() => resolve());
    });
  }

  private open(battleId: string): OpenGame {
    const existing = this.games.get(battleId);
    if (existing) return existing;
    const game: OpenGame = { latencies: [], minTimer: null, throttles: 0 };
    this.games.set(battleId, game);
    return game;
  }

  private write(event: Record<string, unknown>, battleId?: string): void {
    const route = battleId ? this.games.get(battleId) : undefined;
    const configId = route?.configId || this.context.configId;
    const configHash = route?.configHash || this.context.configHash;
    const role = route?.role;
    const share = route?.share;
    const line = {
      v: LIVE_METRICS_VERSION,
      ts: Date.now(),
      runId: this.context.runId,
      batchLabel: this.context.batchLabel ?? null,
      hostname: this.context.hostname ?? null,
      engine: this.context.engine,
      ...(configId ? { configId } : {}),
      ...(configHash ? { configHash } : {}),
      ...(this.context.gitSha ? { gitSha: this.context.gitSha } : {}),
      ...(role ? { role } : {}),
      ...(typeof share === 'number' ? { share } : {}),
      ...event,
    };
    this.stream.write(`${JSON.stringify(line)}\n`);
  }
}
