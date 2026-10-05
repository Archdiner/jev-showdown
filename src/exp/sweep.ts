import { configIdOf } from '../config/hash.js';
import type { BotSpec } from '../config/interfaces.js';
import type { EnvName } from '../config/env.js';
import type { ResolvedConfig } from '../config/schema.js';
import { scoreDev } from './devset.js';
import { gridConfigs, type Axis } from './mutate.js';
import { tuningScore } from './objective.js';
import { playPaired, sideWinRate } from './play.js';

export interface SweepRow {
  configId: string;
  name: string;
  games: number;
  wins: number;
  winRate: number;
  devAgreement: number;
  score: number;
  spec: BotSpec;
}

/**
 * Grid or successive-halving. The objective is game win rate plus dev-set
 * agreement. This module does not load any other position split.
 */
export async function sweep(args: {
  base: ResolvedConfig;
  opponent: BotSpec;
  axes: Axis[];
  method: 'grid' | 'successive-halving';
  games: number;
  seedStart: number;
  env: EnvName;
  devWeight: number;
  llmCostCapUsd?: number;
  poolFile?: string;
}): Promise<SweepRow[]> {
  let active = gridConfigs(args.base, args.axes);
  if (args.method === 'grid') {
    const rows: SweepRow[] = [];
    for (const config of active) rows.push(await scoreOne(config, args, args.games));
    rows.sort((a, b) => b.score - a.score);
    return rows;
  }

  let games = args.games;
  let last: SweepRow[] = [];
  for (;;) {
    last = [];
    for (const config of active) last.push(await scoreOne(config, args, games));
    last.sort((a, b) => b.score - a.score);
    if (active.length <= 1) return last;
    const keep = Math.ceil(active.length / 2);
    active = last.slice(0, keep).map(row => row.spec.config);
    games *= 2;
  }
}

async function scoreOne(
  config: ResolvedConfig,
  args: {
    opponent: BotSpec;
    env: EnvName;
    seedStart: number;
    devWeight: number;
    llmCostCapUsd?: number;
    poolFile?: string;
  },
  games: number
): Promise<SweepRow> {
  const spec: BotSpec = {
    configId: configIdOf(config),
    config,
    env: args.env,
    llmCostCapUsd: args.llmCostCapUsd,
  };
  const results = await playPaired(spec, args.opponent, games, args.seedStart);
  const rate = sideWinRate(results, spec.configId);
  const devAgreement = await scoreDev(spec, args.poolFile);
  return {
    configId: spec.configId,
    name: config.name,
    games: rate.games,
    wins: rate.wins,
    winRate: rate.winRate,
    devAgreement,
    score: tuningScore(rate.winRate, devAgreement, args.devWeight),
    spec,
  };
}
