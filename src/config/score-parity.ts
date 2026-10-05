import * as path from 'path';
import { PRNG } from '@pkmn/sim';
import { legalChoices, startRandomBattle, teamsForSeed } from '../engine/exact/battle-utils.js';
import { EXACT_1PLY, SWITCH_DEPTH2, exactSearch } from '../engine/exact/search.js';
import { loadConfig } from './load.js';
import { createComponent } from './registry.js';
import type { SearchCtx, SearchImpl } from './layers/search.js';
import type { BehaviorImpl } from './layers/opponent.js';
import type { EvalImpl } from './layers/evaluator.js';

export interface ParityRow {
  id: string;
  configId: string;
  seed: number;
  choice: string;
  scores: Array<{ choice: string; score: number }>;
}

const SEEDS = [4, 11];

function opened(seed: number) {
  const teams = teamsForSeed(seed);
  const battle = startRandomBattle(teams.p1, teams.p2, seed);
  if (battle.requestState === 'teampreview') {
    battle.choose('p1', 'default');
    battle.choose('p2', 'default');
  }
  if (legalChoices(battle, 'p1').length === 0) throw new Error(`seed ${seed} has no p1 choice`);
  return battle;
}

/**
 * Full scores for configs that already exist on main. No deadline, so a
 * slower machine cannot drop the last choice.
 */
export async function collectScoreParity(): Promise<ParityRow[]> {
  const rows: ParityRow[] = [];
  const files = [
    ['champion', 'configs/champion.yaml'],
    ['weighted', 'configs/examples/evaluator-weighted.yaml'],
    ['depth-2', 'configs/examples/search-depth-2.yaml'],
  ] as const;
  for (const [name, file] of files) {
    const loaded = loadConfig(path.join(process.cwd(), file));
    const search = createComponent('search', loaded.config.search.id, loaded.config.search.params) as SearchImpl;
    const evaluate = createComponent('evaluator', loaded.config.evaluator.id, loaded.config.evaluator.params) as EvalImpl;
    const behavior = createComponent(
      'behavior',
      loaded.config.opponentModel.behavior.id,
      loaded.config.opponentModel.behavior.params,
    ) as BehaviorImpl;
    for (const seed of SEEDS) {
      const battle = opened(seed);
      const ctx: SearchCtx = {
        evaluate,
        behavior,
        plan: null,
        rng: new PRNG([seed, 1, 2, 3] as never),
      };
      const trace = await search.search(battle, 'p1', ctx);
      rows.push({
        id: name,
        configId: loaded.configId,
        seed,
        choice: trace.choice,
        scores: trace.scores.map(row => ({ choice: row.choice, score: row.score })),
      });
    }
  }
  for (const seed of SEEDS) {
    const battle = opened(seed);
    for (const [name, config] of [['exact-1ply', EXACT_1PLY], ['switch-depth2', SWITCH_DEPTH2]] as const) {
      const trace = exactSearch(battle, 'p1', config);
      rows.push({
        id: name,
        configId: name,
        seed,
        choice: trace.choice,
        scores: trace.scores.map(row => ({ choice: row.choice, score: row.score })),
      });
    }
  }
  return rows;
}

if (process.argv.includes('--dump')) {
  collectScoreParity()
    .then(rows => {
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    })
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}
