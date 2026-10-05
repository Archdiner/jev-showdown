import { parentPort } from 'worker_threads';
import { GameJob, runGame } from './game.js';
import { dataLoader } from '../data/data-loader.js';

interface WorkerRequest {
  type: 'game' | 'stop';
  job?: GameJob;
}

let dataLoaded = false;

parentPort?.on('message', (msg: WorkerRequest) => {
  if (msg.type !== 'game' || !msg.job) return;
  void handle(msg.job);
});

async function handle(job: GameJob): Promise<void> {
  try {
    if (!dataLoaded) {
      await dataLoader.load();
      dataLoaded = true;
    }
    const result = await runGame(job);
    parentPort?.postMessage({ ok: true, result });
  } catch (error) {
    const text = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
    parentPort?.postMessage({ ok: false, error: text });
  }
}
