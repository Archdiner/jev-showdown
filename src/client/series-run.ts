import { LiveDrain, shouldFinishSeries } from './drain.js';

/** How a ladder batch stopped. Written on the summary and the metrics run row. */
export type BatchEndReason = 'completed' | 'drained' | 'stalled';

/**
 * No protocol progress for this long is a stall.
 * A live battle resets it on each turn, request, or search update, so a
 * healthy game that runs for many minutes does not trip it.
 */
export const DEFAULT_SERIES_IDLE_MS = 20 * 60 * 1000;

/** Drain reason when the idle watchdog stops the batch. First request wins. */
export const STALL_DRAIN_REASON = 'stall';

const BATTLE_LINE = /^\|(turn|request|move|switch|drag|win|tie|faint|upkeep|start|replace|poke|teampreview|inactive|inactiveoff|error|bigerror|callback)\|/;
const DASH_LINE = /^\|-(damage|heal|status|curestatus|boost|unboost|miss|fail|supereffective|resisted|crit|hitcount|item|enditem|ability|endability|weather|fieldstart|fieldend|sidestart|sideend|start|end|activate|prepare|mustrecharge|singleturn|singlemove)\|/;

/**
 * A battle or the ladder queue moved. `|t:|` timestamps and chat do not count:
 * only a line that means the battle or the search changed resets the idle window.
 */
export function isBattleActivity(line: string): boolean {
  if (!line) return false;
  if (line.startsWith('|updatesearch|') || line.startsWith('|updatechallenges|')) return true;
  return BATTLE_LINE.test(line) || DASH_LINE.test(line);
}

export function batchEndReason(input: { stalled: boolean; draining: boolean }): BatchEndReason {
  if (input.stalled) return 'stalled';
  if (input.draining) return 'drained';
  return 'completed';
}

export interface SeriesResult<T> {
  games: T[];
  endReason: BatchEndReason;
}

export interface SeriesOptions<T extends { battleId: string }> {
  games: number;
  idleMs: number;
  drain: LiveDrain;
  activeGames: () => number;
  /** Stop queueing new ladder games. Does not forfeit battles already open. */
  stopSearching: () => void;
  /** Queue the next search when a slot is free and the batch is still running. */
  fill: () => void;
  /** Called once, after the batch has decided to exit. */
  onSettle?: () => void;
  onRecorded?: (game: T, finished: number, requested: number) => void;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  /** Returns a cancel function. Tests pass a fake clock. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

export interface LadderSeries<T> {
  noteActivity(): void;
  finish(game: T): void;
  /** Re-read active games. A phantom end uses this so a drain can finish. */
  checkClose(): void;
  readonly finishedCount: number;
  readonly endReason: BatchEndReason | null;
  readonly result: Promise<SeriesResult<T>>;
  start(): void;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/**
 * Run one batch until the requested games finish, the operator drains, or the
 * idle watchdog trips. There is no wall-clock budget. A stall stops new
 * searches and waits until every in-flight game has ended.
 */
export function createLadderSeries<T extends { battleId: string }>(
  options: SeriesOptions<T>,
): LadderSeries<T> {
  if (!Number.isFinite(options.idleMs) || options.idleMs < 1) {
    throw new Error(`idle window must be a positive number of milliseconds (got ${options.idleMs})`);
  }
  const log = options.log ?? (line => console.log(line));
  const warn = options.warn ?? (line => console.warn(line));
  const schedule = options.schedule ?? defaultSchedule;
  const finished = new Map<string, T>();
  let stalled = false;
  let settled = false;
  let started = false;
  let endReason: BatchEndReason | null = null;
  let cancelIdle = () => {};
  let resolveResult: (value: SeriesResult<T>) => void = () => {};
  const result = new Promise<SeriesResult<T>>(resolve => {
    resolveResult = resolve;
  });

  const disarm = () => {
    cancelIdle();
    cancelIdle = () => {};
  };

  const arm = () => {
    disarm();
    cancelIdle = schedule(onIdle, options.idleMs);
  };

  const tryClose = () => {
    if (settled) return;
    if (!shouldFinishSeries({
      finished: finished.size,
      requested: options.games,
      draining: options.drain.isDraining,
      active: options.activeGames(),
    })) return;
    settled = true;
    disarm();
    endReason = batchEndReason({ stalled, draining: options.drain.isDraining });
    options.onSettle?.();
    resolveResult({ games: [...finished.values()], endReason });
  };

  function onIdle(): void {
    if (settled || options.drain.isDraining) return;
    stalled = true;
    warn(
      `[ladder] stalled after ${finished.size}/${options.games} games; ` +
      `no battle activity for ${options.idleMs}ms; draining in-progress games`,
    );
    options.drain.request(STALL_DRAIN_REASON);
  }

  options.drain.onDrain(reason => {
    log(`[ladder] draining (${reason}); in-progress games will finish`);
    options.stopSearching();
    tryClose();
  });

  return {
    get finishedCount() {
      return finished.size;
    },
    get endReason() {
      return endReason;
    },
    result,
    noteActivity() {
      if (settled || stalled || options.drain.isDraining) return;
      arm();
    },
    checkClose() {
      tryClose();
    },
    finish(game: T) {
      this.noteActivity();
      if (finished.has(game.battleId)) {
        if (finished.size < options.games && !options.drain.isDraining) options.fill();
        else tryClose();
        return;
      }
      finished.set(game.battleId, game);
      options.onRecorded?.(game, finished.size, options.games);
      if (finished.size >= options.games || options.drain.isDraining) {
        options.stopSearching();
        tryClose();
        return;
      }
      options.fill();
    },
    start() {
      if (started) return;
      started = true;
      if (options.drain.isDraining) {
        options.stopSearching();
        tryClose();
        return;
      }
      arm();
      options.fill();
    },
  };
}
