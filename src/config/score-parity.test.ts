import { readFileSync } from 'fs';
import * as path from 'path';
import { collectScoreParity } from './score-parity.js';

/**
 * Existing configs, including weighted, must score the same as origin/main
 * at c105e48. The fixture was dumped by running this collector on that commit.
 */
describe('score parity with main', () => {
  test('champion, weighted, depth-2, exact-1ply, and switch-depth2 match the frozen scores', async () => {
    const fixture = JSON.parse(
      readFileSync(path.join(process.cwd(), 'src/config/score-parity.main.json'), 'utf8'),
    );
    const live = await collectScoreParity();
    expect(live).toEqual(fixture);
  }, 120000);
});
