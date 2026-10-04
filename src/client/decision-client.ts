import { Worker } from 'node:worker_threads';
import { Action, BotConfig, GameState } from '../types/index.js';
import { pickBestLegal } from './choice.js';
import { WorkerResponse } from './decision-messages.js';
import { safeError } from './ids.js';

export interface EngineDecision {
  action: Action;
  score: number | null;
  timeMs: number;
  fallback: boolean;
  reason?: string;
}

/**
 * Runs the current champion engine (Bot.selectAction) on a worker thread
 * so a slow search can be abandoned when the battle timer requires a move.
 */
export class DecisionClient {
  private worker: Worker | null = null;
  private readyPromise: Promise<void> | null = null;
  private seq = 0;
  private pending = new Map<number, {
    resolve: (decision: EngineDecision) => void;
    timer: NodeJS.Timeout;
    state: GameState;
    legal: Action[];
    started: number;
  }>();

  constructor(
    private readonly config: BotConfig,
    private readonly timeoutMs: number,
  ) {}

  start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.boot();
    return this.readyPromise;
  }

  async decide(state: GameState, legal: Action[], timeoutMs = this.timeoutMs): Promise<EngineDecision> {
    if (legal.length === 0) {
      throw new Error('decide() called with no legal actions');
    }
    try {
      await this.start();
    } catch (err) {
      return this.fallback(state, legal, 0, `engine unavailable: ${safeError(err)}`);
    }
    if (!this.worker) {
      return this.fallback(state, legal, 0, 'engine unavailable');
    }

    const id = ++this.seq;
    const started = Date.now();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        void this.restartAfterTimeout();
        resolve(this.fallback(state, legal, Date.now() - started, 'engine timeout'));
      }, timeoutMs);

      this.pending.set(id, { resolve, timer, state, legal, started });
      this.worker?.postMessage({ type: 'decide', id, state, legal });
    });
  }

  async stop(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.readyPromise = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve(this.fallback(pending.state, pending.legal, Date.now() - pending.started, 'engine stopped'));
      this.pending.delete(id);
    }
    if (worker) await worker.terminate();
  }

  private boot(): Promise<void> {
    const worker = new Worker(new URL('./decision-worker.ts', import.meta.url), {
      execArgv: ['--import', 'tsx'],
    });
    this.worker = worker;

    return new Promise((resolve, reject) => {
      const fail = (err: unknown) => {
        if (this.worker === worker) {
          this.worker = null;
          this.readyPromise = null;
        }
        reject(err instanceof Error ? err : new Error(safeError(err)));
      };

      const bootTimer = setTimeout(() => fail(new Error('engine worker startup timed out')), 30000);

      worker.on('message', (message: WorkerResponse) => {
        if (message.type === 'ready') {
          clearTimeout(bootTimer);
          resolve();
          return;
        }
        if (message.type === 'worker-error') {
          clearTimeout(bootTimer);
          fail(new Error(message.message));
          return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        pending.resolve({
          action: message.action,
          score: message.score,
          timeMs: message.timeMs,
          fallback: message.fallback,
          reason: message.reason,
        });
      });

      worker.once('error', err => {
        clearTimeout(bootTimer);
        this.failPending(`engine worker error: ${safeError(err)}`);
        fail(err);
      });

      worker.once('exit', code => {
        clearTimeout(bootTimer);
        if (this.worker === worker && code !== 0) {
          this.failPending(`engine worker exited (${code})`);
          fail(new Error(`engine worker exited (${code})`));
        }
      });

      worker.postMessage({ type: 'init', config: this.config });
    });
  }

  private failPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve(this.fallback(pending.state, pending.legal, Date.now() - pending.started, reason));
      this.pending.delete(id);
    }
  }

  private async restartAfterTimeout(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.readyPromise = null;
    if (worker) {
      await worker.terminate();
    }
    try {
      await this.start();
    } catch (err) {
      console.error(`[engine] restart failed: ${safeError(err)}`);
    }
  }

  private fallback(state: GameState, legal: Action[], timeMs: number, reason: string): EngineDecision {
    let action = legal[0];
    try {
      action = pickBestLegal(state, legal);
    } catch {
      action = legal[0];
    }
    return { action, score: null, timeMs, fallback: true, reason };
  }
}
