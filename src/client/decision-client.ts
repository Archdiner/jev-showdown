import { Worker } from 'node:worker_threads';
import { Action, BotConfig, GameState } from '../types/index.js';
import { pickBestLegal } from './choice.js';
import { WorkerResponse } from './decision-messages.js';
import { LivePosition } from './decision-battle.js';
import { budgetSearchMs, EngineName } from './engines.js';
import { safeError } from './ids.js';

export interface EngineDecision {
  action: Action;
  score: number | null;
  timeMs: number;
  fallback: boolean;
  reason?: string;
}

export interface DecisionClientOptions {
  config: BotConfig;
  engine: EngineName;
  timeoutMs: number;
  workers: number;
  /** Loaded once at worker start. Not replaced while the batch is running. */
  championConfigPath?: string | null;
}

interface PendingDecision {
  resolve: (decision: EngineDecision) => void;
  timer: NodeJS.Timeout;
  state: GameState;
  legal: Action[];
  started: number;
}

interface WorkerSlot {
  worker: Worker | null;
  battles: Set<string>;
  pending: Map<number, PendingDecision>;
  ready: Promise<void> | null;
}

/**
 * One worker thread per active battle. Engines are created per room id and
 * never reused for another battle.
 */
export class DecisionClient {
  private readonly slots: WorkerSlot[] = [];
  private started: Promise<void> | null = null;
  private seq = 0;
  private inFlight = 0;
  private readonly battleSlot = new Map<string, WorkerSlot>();

  constructor(private readonly options: DecisionClientOptions) {}

  start(): Promise<void> {
    if (this.started) return this.started;
    const count = Math.max(1, this.options.workers);
    this.started = Promise.all(Array.from({ length: count }, () => this.boot())).then(slots => {
      this.slots.push(...slots);
    });
    return this.started;
  }

  openBattle(battleId: string): void {
    const slot = this.claim(battleId);
    slot.worker?.postMessage({ type: 'open-battle', battleId });
  }

  closeBattle(battleId: string): void {
    const slot = this.battleSlot.get(battleId);
    if (!slot) return;
    slot.battles.delete(battleId);
    this.battleSlot.delete(battleId);
    slot.worker?.postMessage({ type: 'close-battle', battleId });
  }

  async decide(
    battleId: string,
    state: GameState,
    legal: Action[],
    timeoutMs = this.options.timeoutMs,
    position?: LivePosition,
  ): Promise<EngineDecision> {
    if (legal.length === 0) {
      throw new Error('decide() called with no legal actions');
    }
    this.inFlight += 1;
    const searchTimeMs = Math.min(
      budgetSearchMs(this.options.config.searchTimeMs, this.inFlight),
      Math.max(50, timeoutMs - 50),
    );
    try {
      await this.start();
      const slot = this.claim(battleId);
      if (!slot.worker) {
        return this.fallback(state, legal, 0, 'engine unavailable');
      }
      await slot.ready;
      return await this.send(slot, battleId, state, legal, timeoutMs, searchTimeMs, position);
    } catch (err) {
      return this.fallback(state, legal, 0, `engine unavailable: ${safeError(err)}`);
    } finally {
      this.inFlight -= 1;
    }
  }

  async stop(): Promise<void> {
    const slots = this.slots.splice(0);
    this.started = null;
    this.battleSlot.clear();
    await Promise.all(slots.map(slot => this.terminate(slot, 'engine stopped')));
  }

  private claim(battleId: string): WorkerSlot {
    const existing = this.battleSlot.get(battleId);
    if (existing) return existing;
    const slot = this.slots.slice().sort((a, b) => a.battles.size - b.battles.size)[0];
    if (!slot) throw new Error('engine workers are not started');
    slot.battles.add(battleId);
    this.battleSlot.set(battleId, slot);
    slot.worker?.postMessage({ type: 'open-battle', battleId });
    return slot;
  }

  private send(
    slot: WorkerSlot,
    battleId: string,
    state: GameState,
    legal: Action[],
    timeoutMs: number,
    searchTimeMs: number,
    position?: LivePosition,
  ): Promise<EngineDecision> {
    const id = ++this.seq;
    const started = Date.now();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (!slot.pending.has(id)) return;
        slot.pending.delete(id);
        void this.restart(slot);
        resolve(this.fallback(state, legal, Date.now() - started, 'engine timeout'));
      }, timeoutMs);

      slot.pending.set(id, { resolve, timer, state, legal, started });
      slot.worker?.postMessage({
        type: 'decide',
        id,
        battleId,
        state,
        legal,
        searchTimeMs,
        position,
      });
    });
  }

  private boot(): Promise<WorkerSlot> {
    const slot: WorkerSlot = {
      worker: null,
      battles: new Set(),
      pending: new Map(),
      ready: null,
    };
    slot.ready = this.launch(slot);
    return slot.ready.then(() => slot);
  }

  private launch(slot: WorkerSlot): Promise<void> {
    const worker = new Worker(new URL('./decision-worker-entry.js', import.meta.url));
    slot.worker = worker;

    return new Promise((resolve, reject) => {
      const fail = (err: unknown) => {
        if (slot.worker === worker) slot.worker = null;
        reject(err instanceof Error ? err : new Error(safeError(err)));
      };

      let readySent = false;
      const bootTimer = setTimeout(() => fail(new Error('engine worker startup timed out')), 30000);

      worker.on('message', (message: WorkerResponse) => {
        if (message.type === 'ready') {
          readySent = true;
          clearTimeout(bootTimer);
          resolve();
          return;
        }
        if (message.type === 'worker-error') {
          if (!readySent) {
            clearTimeout(bootTimer);
            this.failPending(slot, message.message);
            fail(new Error(message.message));
          } else {
            console.error(`[engine] ${message.message}`);
          }
          return;
        }
        const pending = slot.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        slot.pending.delete(message.id);
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
        this.failPending(slot, `engine worker error: ${safeError(err)}`);
        fail(err);
      });

      worker.once('exit', code => {
        clearTimeout(bootTimer);
        if (slot.worker === worker && code !== 0) {
          this.failPending(slot, `engine worker exited (${code})`);
          fail(new Error(`engine worker exited (${code})`));
        }
      });

      worker.postMessage({
        type: 'init',
        config: this.options.config,
        engine: this.options.engine,
        championConfigPath: this.options.championConfigPath ?? null,
      });
    });
  }

  private async restart(slot: WorkerSlot): Promise<void> {
    const battles = [...slot.battles];
    await this.terminate(slot, 'engine restarted after timeout');
    try {
      slot.ready = this.launch(slot);
      await slot.ready;
      for (const battleId of battles) {
        slot.battles.add(battleId);
        slot.worker?.postMessage({ type: 'open-battle', battleId });
      }
    } catch (err) {
      console.error(`[engine] restart failed: ${safeError(err)}`);
    }
  }

  private async terminate(slot: WorkerSlot, reason: string): Promise<void> {
    const worker = slot.worker;
    slot.worker = null;
    slot.ready = null;
    this.failPending(slot, reason);
    if (worker) await worker.terminate();
  }

  private failPending(slot: WorkerSlot, reason: string): void {
    for (const [id, pending] of slot.pending) {
      clearTimeout(pending.timer);
      pending.resolve(this.fallback(pending.state, pending.legal, Date.now() - pending.started, reason));
      slot.pending.delete(id);
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
