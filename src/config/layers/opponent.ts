import type { Battle } from '@pkmn/sim';
import { legalChoices, type SideId } from '../../engine/exact/battle-utils.js';
import { maxDamageChoice } from '../../engine/exact/max-damage.js';
import { OpponentModel } from '../../engine/opponent-model.js';
import type { PokemonBelief } from '../../types/index.js';
import { register } from '../registry.js';
import {
  BehaviorParamsSchema,
  CategoryPriorsSchema,
  SetInferenceParamsSchema,
  type BehaviorParams,
  type SetInferenceParams,
} from '../schema.js';
import { moveOf } from './battle.js';

export interface OpponentLine {
  choice: string;
  weight: number;
}

export interface BehaviorImpl {
  id: string;
  params: BehaviorParams;
  /** When set, exactSearch can model the opponent. Otherwise the wrapper enumerates lines. */
  exactModel: 'max-damage' | 'uniform' | null;
  lines(battle: Battle, side: SideId, rating?: number): OpponentLine[];
}

export interface SetInferenceImpl {
  id: string;
  params: SetInferenceParams;
  narrow(belief: PokemonBelief): Array<{ role: string; probability: number; moves: string[] }>;
}

const model = new OpponentModel();

export function registerOpponent(): void {
  register<SetInferenceParams>({
    layer: 'setInference',
    id: 'strict',
    schema: SetInferenceParamsSchema,
    defaults: { minRoleWeight: 0.15, maxCandidates: 4 },
    create: params => inference('strict', params),
  });
  register<SetInferenceParams>({
    layer: 'setInference',
    id: 'loose',
    schema: SetInferenceParamsSchema,
    defaults: { minRoleWeight: 0, maxCandidates: 12 },
    create: params => inference('loose', params),
  });
  register<SetInferenceParams>({
    layer: 'setInference',
    id: 'unconstrained',
    schema: SetInferenceParamsSchema,
    defaults: { minRoleWeight: 0, maxCandidates: 32 },
    create: params => inference('unconstrained', params),
  });

  const behaviorDefaults = BehaviorParamsSchema.parse({});
  const specs: Array<[string, 'max-damage' | 'uniform' | null, Partial<BehaviorParams>]> = [
    ['max-damage', 'max-damage', {}],
    ['uniform', 'uniform', {}],
    ['switch-prone', null, { switchWeight: 2.5, priors: { ...behaviorDefaults.priors, switch: 2.5 } }],
    ['replay-prior', null, { ratingConditioned: true }],
    ['jev-predictor', null, { switchWeight: 1.5, priors: { ...behaviorDefaults.priors, switch: 1.5 } }],
  ];
  for (const [id, exactModel, patch] of specs) {
    const defaults = BehaviorParamsSchema.parse(patch);
    register<BehaviorParams>({
      layer: 'behavior',
      id,
      schema: BehaviorParamsSchema,
      defaults,
      create: params => ({
        id,
        params,
        exactModel,
        lines(battle: Battle, side: SideId, rating?: number) {
          return behaviorLines(id, params, battle, side, rating);
        },
      }),
    });
  }
}

function inference(id: string, params: SetInferenceParams): SetInferenceImpl {
  return {
    id,
    params,
    narrow(belief) {
      let rows: Array<{ role: string; probability: number; moves: string[] }> = [];
      try {
        rows = model.getPossibleSets(belief).map(row => ({
          role: row.role,
          probability: row.probability,
          moves: row.moves,
        }));
      } catch {
        rows = [];
      }
      if (id !== 'unconstrained' && params.minRoleWeight > 0) {
        rows = rows.filter(row => row.probability >= params.minRoleWeight);
      }
      return rows.slice(0, params.maxCandidates);
    },
  };
}

function behaviorLines(
  id: string,
  params: BehaviorParams,
  battle: Battle,
  side: SideId,
  rating?: number
): OpponentLine[] {
  const legal = legalChoices(battle, side);
  if (legal.length === 0) return [];
  if (id === 'max-damage') {
    const moves = legal.filter(choice => choice.startsWith('move '));
    const choice = moves.length ? maxDamageChoice(battle, side, moves) : legal[0];
    return [{ choice, weight: 1 }];
  }
  if (id === 'uniform') return legal.map(choice => ({ choice, weight: 1 }));

  const ratingBoost = params.ratingConditioned && (rating ?? 0) >= 1400 ? 1.25 : 1;
  return legal.map(choice => {
    if (choice.startsWith('switch ')) {
      const weight = (id === 'switch-prone' || id === 'jev-predictor' ? params.switchWeight : params.priors.switch) * ratingBoost;
      return { choice, weight };
    }
    const move = moveOf(battle, side, choice);
    if (!move) return { choice, weight: 1 };
    let weight = params.priors[categoryKey(move)] ?? 1;
    if (move.sideCondition && move.target === 'foeSide') weight *= params.priors.hazard;
    if (move.boosts) weight *= params.priors.setup;
    if (move.priority > 0) weight *= params.priors.priority;
    return { choice, weight };
  });
}

function categoryKey(move: { category: string }): 'physical' | 'special' | 'status' {
  if (move.category === 'Physical') return 'physical';
  if (move.category === 'Special') return 'special';
  return 'status';
}

export { CategoryPriorsSchema };
