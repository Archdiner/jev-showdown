import { Worker } from 'worker_threads';
import os from 'os';
import { GameJob, GameResult } from './game.js';

interface WorkerMessage {
  ok: boolean;
  result?: GameResult;
  error?: string;
}

/**
 * V8 sizes each isolate from the host's total RAM. On this machine that is
 * about 4GB per worker. Four of those heaps, replaced every game, still
 * leave a collection pause longer than a turn. The cap is a latency budget.
 * It does not change which move is chosen.
 */
const WORKER_OLD_SPACE_MB = 384;

/**
 * Run games across all CPU cores. Each job is one game.
 * A worker is replaced after every game, and the next one starts only
 * after the previous isolate is gone, so a panel never holds two copies
 * of the same slot's heap.
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
    const worker = new Worker(new URL('./worker.js', import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: WORKER_OLD_SPACE_MB },
    });
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

      const retire = async (worker: Worker) => {
        live.delete(worker);
        await worker.terminate();
      };

      const assign = (worker: Worker) => {
        if (failed || cursor >= jobs.length) {
          void retire(worker);
          return;
        }
        const job = jobs[cursor++];
        const onMessage = (msg: WorkerMessage) => {
          worker.off('message', onMessage);
          if (!msg.ok || !msg.result) {
            fail(new Error(msg.error || `worker failed on game ${job.index}`));
            void retire(worker);
            return;
          }
          results[job.index] = msg.result;
          finished++;
          if (finished % 20 === 0 || finished === jobs.length) {
            console.log(`  ${finished}/${jobs.length} games finished`);
          }
          const done = finished === jobs.length;
          void retire(worker).then(() => {
            if (failed) return;
            if (done) resolve();
            else assign(spawn());
          }).catch(err => fail(err instanceof Error ? err : new Error(String(err))));
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
