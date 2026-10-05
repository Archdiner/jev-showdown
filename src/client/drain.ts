import * as fs from 'fs';
import * as path from 'path';

/** Repo-wide switch. Delete it before the next run or the runner will not search. */
export const GLOBAL_DRAIN_FILE = path.resolve('state/DRAIN');

export function runDrainFile(runId: string): string {
  return path.resolve('live-runs', `${runId}.drain`);
}

export function runMetaFile(runId: string): string {
  return path.resolve('live-runs', `${runId}.json`);
}

export function drainWatchPaths(runId: string, extra: string[] = []): string[] {
  return [GLOBAL_DRAIN_FILE, runDrainFile(runId), ...extra.map(file => path.resolve(file))];
}

export function findDrainFile(paths: string[]): string | null {
  for (const filePath of paths) {
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

/** Poll until one of `paths` exists, then call `onDrain` once. */
export function watchDrainFiles(
  paths: string[],
  onDrain: (filePath: string) => void,
  intervalMs = 500,
): { stop(): void } {
  const existing = findDrainFile(paths);
  if (existing) {
    onDrain(existing);
    return { stop() {} };
  }
  const timer = setInterval(() => {
    const hit = findDrainFile(paths);
    if (!hit) return;
    clearInterval(timer);
    onDrain(hit);
  }, intervalMs);
  timer.unref?.();
  return { stop() { clearInterval(timer); } };
}

/**
 * Account-level drain. `request` is idempotent.
 * ops `runLive` should share one of these and skip `client.search()` while `isDraining`.
 */
export class LiveDrain {
  private draining = false;
  private reason: string | null = null;
  private readonly listeners: Array<(reason: string) => void> = [];

  get isDraining(): boolean {
    return this.draining;
  }

  get drainReason(): string | null {
    return this.reason;
  }

  request(reason: string): void {
    if (this.draining) return;
    this.draining = true;
    this.reason = reason;
    for (const listener of [...this.listeners]) listener(reason);
  }

  onDrain(listener: (reason: string) => void): void {
    this.listeners.push(listener);
    if (this.draining && this.reason) listener(this.reason);
  }
}

/** Finish the process once requested games are done, or once a drain has no games left. */
export function shouldFinishSeries(input: {
  finished: number;
  requested: number;
  draining: boolean;
  active: number;
}): boolean {
  if (input.active > 0) return false;
  return input.draining || input.finished >= input.requested;
}

/**
 * First SIGTERM or SIGUSR1 drains. A second one exits.
 * A forced exit still does not send /forfeit; it only drops the socket.
 */
export function installDrainSignals(onDrain: (signal: string) => void): () => void {
  let armed = false;
  const handler = (signal: NodeJS.Signals) => {
    if (armed) {
      console.error(`[ladder] ${signal} repeated, exiting without waiting`);
      process.exit(1);
    }
    armed = true;
    console.log(`[ladder] ${signal} received, draining in-progress games`);
    onDrain(signal);
  };
  process.on('SIGTERM', handler);
  process.on('SIGUSR1', handler);
  return () => {
    process.off('SIGTERM', handler);
    process.off('SIGUSR1', handler);
  };
}
