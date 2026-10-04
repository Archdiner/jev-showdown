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
 * Workers stay warm and pull jobs until the queue is empty.
 */
export async function runGamesParallel(
  jobs: GameJob[],
  concurrency = os.cpus().length,
): Promise<GameResult[]> {
  if (jobs.length === 0) return [];
  const workerCount = Math.max(1, Math.min(concurrency, jobs.length));
  const workers = Array.from({ length: workerCount }, () => new Worker(new URL('./worker.js', import.meta.url)));
  const results: GameResult[] = new Array(jobs.length);
  let cursor = 0;
  let finished = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      let failed = false;
      const fail = (err: Error) => {
        if (failed) return;
        failed = true;
        reject(err);
      };

      const assign = (worker: Worker) => {
        if (failed) return;
        if (cursor >= jobs.length) return;
        const job = jobs[cursor++];
        const onMessage = (msg: WorkerMessage) => {
          worker.off('message', onMessage);
          if (!msg.ok || !msg.result) {
            fail(new Error(msg.error || `worker failed on game ${job.index}`));
            return;
          }
          results[job.index] = msg.result;
          finished++;
          if (finished % 20 === 0 || finished === jobs.length) {
            console.log(`  ${finished}/${jobs.length} games finished`);
          }
          if (finished === jobs.length) {
            resolve();
            return;
          }
          assign(worker);
        };
        worker.on('message', onMessage);
        worker.postMessage({ type: 'game', job });
      };

      for (const worker of workers) {
        worker.on('error', err => fail(err));
        assign(worker);
      }
    });
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
  }

  return results;
}

export function p99(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));
  return sorted[index];
}
