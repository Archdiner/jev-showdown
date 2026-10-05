import { Battle } from '@pkmn/sim';
import type { SideId } from './battle-utils.js';
import { applyStandard, TEAM_EVAL_FEATURES, teamFeatureVector } from './team-features.js';
import model from './eval-weights.json' with { type: 'json' };

/**
 * Leaf evaluation whose weights are the logistic fit in eval-weights.json.
 * Sampled-world search passes evalMode 'fitted' into exactSearch.
 * The config evaluator `fitted-team` calls fittedTeamEval.
 * A terminal win stays at ±1000 so a finished game outranks any in-game logit.
 */
export interface FittedModel {
  features: string[];
  weights: number[];
  mean: number[];
  std: number[];
  lambda: number;
  epochs: number;
}

const fitted = model as FittedModel;

if (fitted.features.join('|') !== TEAM_EVAL_FEATURES.join('|')) {
  throw new Error('eval-weights.json features do not match TEAM_EVAL_FEATURES');
}
if (fitted.weights.length !== TEAM_EVAL_FEATURES.length) {
  throw new Error('eval-weights.json has the wrong width');
}

export function fittedModel(): FittedModel {
  return fitted;
}

export function fittedTeamEval(battle: Battle, side: SideId): number {
  if (battle.ended && battle.winner) {
    const me = battle.getSide(side);
    return battle.winner === me.name ? 1000 : -1000;
  }
  const scaled = applyStandard(teamFeatureVector(battle, side), fitted.mean, fitted.std);
  let score = 0;
  for (let i = 0; i < fitted.weights.length; i++) score += fitted.weights[i] * (scaled[i] || 0);
  return score;
}
