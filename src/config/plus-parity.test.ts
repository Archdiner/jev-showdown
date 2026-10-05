import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from '@jest/globals';
import { loadConfig } from './load.js';
import { collectPlusParity } from './plus-parity.js';

const cfg = (name: string) => loadConfig(path.join(process.cwd(), 'configs', `${name}.yaml`));
const hasData = fs.existsSync(path.join(process.cwd(), 'data', 'gen9-stats.json'));
const describeData = hasData ? describe : describe.skip;

describe('stacked-plus config', () => {
  it('leaves champion and stacked-qw-fitted config ids unchanged', () => {
    expect(cfg('champion').configId).toBe('064cad7ec4ed0241');
    expect(cfg('stacked-qw-fitted').configId).toBe('a582e1386f6392ce');
    const params = cfg('stacked-qw-fitted').config.search.params as Record<string, unknown>;
    expect(params.foeBelief).toBeUndefined();
    expect(params.replyModel).toBeUndefined();
    expect(params.replySwitchMax).toBeUndefined();
  });

  it('differs from stacked-qw-fitted only by foeBelief + replyModel: switch (top 3)', () => {
    const stacked = cfg('stacked-qw-fitted').config as any;
    const plus = cfg('stacked-plus').config as any;
    expect(plus.search.params.foeBelief).toBe(true);
    expect(plus.search.params.replyModel).toBe('switch');
    expect(plus.search.params.replySwitchMax).toBe(3);
    const strip = (config: any) => {
      const copy = JSON.parse(JSON.stringify(config));
      delete copy.name;
      delete copy.search.params.foeBelief;
      delete copy.search.params.replyModel;
      delete copy.search.params.replySwitchMax;
      return copy;
    };
    expect(strip(plus)).toEqual(strip(stacked));
  });

  it('composes the two screened arms exactly', () => {
    const plus = cfg('stacked-plus').config as any;
    const belief = cfg('stacked-qw-fitted-belief').config as any;
    const switchreply = cfg('stacked-qw-fitted-switchreply').config as any;
    expect(plus.search.params.foeBelief).toBe(belief.search.params.foeBelief);
    expect(plus.search.params.replyModel).toBe(switchreply.search.params.replyModel);
    expect(plus.search.params.replySwitchMax).toBe(switchreply.search.params.replySwitchMax);
    expect(plus.opponentModel).toEqual(belief.opponentModel);
    expect(plus.opponentModel).toEqual(switchreply.opponentModel);
  });
});

/**
 * Behavioural parity: every choice of stacked-qw-fitted vs champion (both
 * seats, hidden info) on fixed seeds. The golden was dumped on 90bf07f and is
 * identical to 7a7fb38 (before the f-series opt-in code), so none of the
 * opt-in search params change the default paths.
 * Regenerate only for an intended default-path change:
 *   npx tsx scripts/dump-plus-parity.ts src/config/plus-parity.golden.json
 */
describeData('champion / stacked-qw-fitted behavioural parity', () => {
  it('replays the frozen decision traces', async () => {
    const golden = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'src/config/plus-parity.golden.json'), 'utf8'),
    );
    expect(await collectPlusParity()).toEqual(golden);
  }, 240000);
});
