import { configIdOf } from '../config/hash.js';
import type { BotSpec } from '../config/interfaces.js';
import type { EnvName } from '../config/env.js';
import type { ResolvedConfig } from '../config/schema.js';
import { scoreDev } from './devset.js';
import { ablationConfigs } from './mutate.js';
import { tuningScore } from './objective.js';
import { playPaired, sideWinRate } from './play.js';

export interface AblationRow {
  label: string;
  configId: string;
  games: number;
  wins: number;
  winRate: number;
  devAgreement: number;
  score: number;
}

/** Knock out one layer or term at a time. Scored on games plus the dev set. */
export async function ablate(args: {
  config: ResolvedConfig;
  opponent: BotSpec;
  games: number;
  seedStart: number;
  env: EnvName;
  devWeight?: number;
  llmCostCapUsd?: number;
  poolFile?: string;
}): Promise<AblationRow[]> {
  const rows: AblationRow[] = [];
  for (const variant of ablationConfigs(args.config)) {
    const spec: BotSpec = {
      configId: configIdOf(variant.config),
      config: variant.config,
      env: args.env,
      llmCostCapUsd: args.llmCostCapUsd,
    };
    const results = await playPaired(spec, args.opponent, args.games, args.seedStart);
    const rate = sideWinRate(results, spec.configId);
    const devAgreement = await scoreDev(spec, args.poolFile);
    rows.push({
      label: variant.label,
      configId: spec.configId,
      games: rate.games,
      wins: rate.wins,
      winRate: rate.winRate,
      devAgreement,
      score: tuningScore(rate.winRate, devAgreement, args.devWeight ?? 1),
    });
  }
  rows.sort((a, b) => a.score - b.score);
  return rows;
}
