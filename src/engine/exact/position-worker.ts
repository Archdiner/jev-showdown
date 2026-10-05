import { parentPort } from 'worker_threads';
import { takeRandomPosition } from './position-sets.js';

parentPort?.on('message', (msg: { seed?: number }) => {
  if (typeof msg.seed !== 'number') return;
  try {
    const position = takeRandomPosition(msg.seed);
    parentPort?.postMessage({ ok: true, position });
  } catch (error) {
    const text = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
    parentPort?.postMessage({ ok: false, error: text });
  }
});
