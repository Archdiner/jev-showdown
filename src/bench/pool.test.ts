import { benchWorkerUrl } from './worker-url.js';

test('tsx loads the TypeScript worker entry instead of a missing worker.js', () => {
  const url = benchWorkerUrl('file:///repo/src/bench/pool.ts');
  expect(url.pathname.endsWith('/worker-entry.js')).toBe(true);
});
