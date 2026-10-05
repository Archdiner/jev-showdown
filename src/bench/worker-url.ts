import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

/** Compiled `worker.js` after `tsc`. The tsx entry otherwise, so `npm run jev:eval` needs no build. */
export function benchWorkerUrl(moduleUrl: string): URL {
  const compiled = new URL('./worker.js', moduleUrl);
  if (moduleUrl.endsWith('.js') && existsSync(fileURLToPath(compiled))) return compiled;
  return new URL('./worker-entry.js', moduleUrl);
}
