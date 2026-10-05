import { Worker } from 'worker_threads';
import os from 'os';
import { GameJob, GameResult } from './game.js';

interface WorkerMessage {
  ok: boolean;
  result?: GameResult;
  error?: string;
}

/**
 * Run games across all CPU cores. Each job is one game.
 * A worker is replaced after every game. A warm worker that plays a
 * whole panel keeps a multi-GB heap, and a garbage-collection pause
 * then shows up as a turn over the 2s guardrail.
 */
export async function runGamesParallel(
  jobs: GameJob[],
  concurrency = os.cpus().length,
): Promise<GameResult[]> {
  if (jobs.length === 0) return [];
  const workerCount = Math.max(1, Math.min(concurrency, jobs.length));
  const results: GameResult[] = new Array(jobs.length);
  const live = new Set<Worker>();
  let cursor = 0;
  let finished = 0;

  const spawn = (): Worker => {
    const worker = new Worker(new URL('./worker.js', import.meta.url));
    live.add(worker);
    return worker;
  };

  try {
    await new Promise<void>((resolve, reject) => {
      let failed = false;
      const fail = (err: Error) => {
        if (failed) return;
        failed = true;
        reject(err);
      };

      const retire = (worker: Worker) => {
        live.delete(worker);
        void worker.terminate();
      };

      const assign = (worker: Worker) => {
        if (failed || cursor >= jobs.length) {
          retire(worker);
          return;
        }
        const job = jobs[cursor++];
        const onMessage = (msg: WorkerMessage) => {
          worker.off('message', onMessage);
          if (!msg.ok || !msg.result) {
            fail(new Error(msg.error || `worker failed on game ${job.index}`));
            retire(worker);
            return;
          }
          results[job.index] = msg.result;
          finished++;
          if (finished % 20 === 0 || finished === jobs.length) {
            console.log(`  ${finished}/${jobs.length} games finished`);
          }
          const done = finished === jobs.length;
          const next = done || failed ? null : spawn();
          retire(worker);
          if (done && !failed) resolve();
          if (next) assign(next);
        };
        worker.on('message', onMessage);
        worker.on('error', err => fail(err));
        worker.postMessage({ type: 'game', job });
      };

      for (let i = 0; i < workerCount; i++) assign(spawn());
    });
  } finally {
    await Promise.all([...live].map(worker => worker.terminate()));
  }

  return results;
}

export function p99(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));
  return sorted[index];
}
