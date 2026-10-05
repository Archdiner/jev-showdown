import type { Battle } from '@pkmn/sim';
import { hpEval, type SideId } from '../../engine/exact/battle-utils.js';
import { fittedTeamEval } from '../../engine/exact/fitted-eval.js';
import { battleToState } from '../../engine/exact/search.js';
import { Evaluator } from '../../engine/evaluator.js';
import { register } from '../registry.js';
import { EvaluatorParamsSchema, defaultWeights, type EvaluatorParams, type Weights } from '../schema.js';
import type { GamePlan } from '../interfaces.js';
import { bestStat, boostSum, hazardScore, hpFrac, otherSide } from './battle.js';

export interface EvalImpl {
  id: string;
  params: EvaluatorParams;
  /**
   * `hp`, `full`, and `fitted` are scored inside exactSearch.
   * `weighted` is scored here from the config weights.
   * `fitted` reads the logistic team-eval weights.
   */
  kind: 'hp' | 'full' | 'weighted' | 'fitted';
  score(battle: Battle, side: SideId, plan: GamePlan | null): number;
}

const legacy = new Evaluator();

export function registerEvaluators(): void {
  register<EvaluatorParams>({
    layer: 'evaluator',
    id: 'hp-fraction',
    schema: EvaluatorParamsSchema,
    defaults: { weights: defaultWeights() },
    create: params => ({
      id: 'hp-fraction',
      params,
      kind: 'hp' as const,
      score: (battle: Battle, side: SideId) => hpEval(battle, side),
    }),
  });

  register<EvaluatorParams>({
    layer: 'evaluator',
    id: 'legacy-full',
    schema: EvaluatorParamsSchema,
    defaults: { weights: defaultWeights() },
    create: params => ({
      id: 'legacy-full',
      params,
      kind: 'full' as const,
      score: (battle: Battle, side: SideId) => legacy.evaluate(battleToState(battle, side)).score,
    }),
  });

  register<EvaluatorParams>({
    layer: 'evaluator',
    id: 'fitted-team',
    schema: EvaluatorParamsSchema,
    defaults: { weights: defaultWeights() },
    create: params => ({
      id: 'fitted-team',
      params,
      kind: 'fitted' as const,
      score: (battle: Battle, side: SideId) => fittedTeamEval(battle, side),
    }),
  });

  register<EvaluatorParams>({
    layer: 'evaluator',
    id: 'weighted',
    schema: EvaluatorParamsSchema,
    defaults: { weights: defaultWeights() },
    create: params => ({
      id: 'weighted',
      params,
      kind: 'weighted' as const,
      score: (battle: Battle, side: SideId, plan: GamePlan | null) => weightedScore(battle, side, params.weights, plan),
    }),
  });
}

export function weightedScore(battle: Battle, side: SideId, weights: Weights, plan: GamePlan | null): number {
  const me = battle.getSide(side);
  if (battle.ended && battle.winner) return battle.winner === me.name ? 1000 : -1000;
  const foe = me.foe;
  let hpDiff = 0;
  let monCount = 0;
  for (const mon of me.pokemon) {
    hpDiff += hpFrac(mon);
    if (mon && !mon.fainted && mon.hp > 0) monCount += 1;
  }
  for (const mon of foe.pokemon) {
    hpDiff -= hpFrac(mon);
    if (mon && !mon.fainted && mon.hp > 0) monCount -= 1;
  }
  const speedGap = Math.sign(bestStat(battle, side, 'spe') - bestStat(battle, otherSide(side), 'spe'));
  const tera = teraAvailable(me) - teraAvailable(foe);
  const status = statusCount(foe) - statusCount(me);
  const boosts = boostSum(me.active[0]) - boostSum(foe.active[0]);
  const winHp = plan ? speciesHp(me, plan.winCondition) : 0;
  const preserve = plan ? plan.preserve.reduce((sum, name) => sum + speciesHp(me, name), 0) : 0;
  return (
    weights.hpDifference * hpDiff +
    weights.monCount * monCount +
    weights.hazards * (hazardScore(battle, otherSide(side)) - hazardScore(battle, side)) +
    weights.speedOption * speedGap +
    weights.teraAvailability * tera +
    weights.status * status +
    weights.boosts * boosts +
    weights.winConditionHealth * winHp +
    weights.preservation * preserve
  );
}

function teraAvailable(side: Battle['p1']): number {
  return side.pokemon.some(mon => Boolean((mon as { terastallized?: string }).terastallized)) ? 0 : 1;
}

function statusCount(side: Battle['p1']): number {
  return side.pokemon.filter(mon => mon && !mon.fainted && mon.status).length;
}

function speciesHp(side: Battle['p1'], species: string): number {
  const mon = side.pokemon.find(candidate => candidate.species?.name === species);
  return hpFrac(mon);
}
