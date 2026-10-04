import { Battle, PRNG } from '@pkmn/sim';
import { SideId, legalChoices } from './battle-utils.js';
import { maxDamageChoice } from './max-damage.js';
import { EXACT_1PLY, ExactConfig, ScoredChoice, exactSearch } from './search.js';

export type PolicySpec =
  | { kind: 'random' }
  | { kind: 'maxdamage' }
  | { kind: 'exact'; config: ExactConfig };

export interface Decision {
  choice: string;
  ms: number;
  scores?: ScoredChoice[];
}

export function decide(spec: PolicySpec, battle: Battle, side: SideId, rng: PRNG): Decision {
  const started = Date.now();
  const legal = legalChoices(battle, side);
  if (legal.length === 0) {
    return { choice: 'default', ms: Date.now() - started };
  }

  if (spec.kind === 'random') {
    const choice = legal[rng.random(legal.length)];
    return { choice, ms: Date.now() - started };
  }

  if (spec.kind === 'maxdamage') {
    return { choice: maxDamageChoice(battle, side, legal), ms: Date.now() - started };
  }

  const trace = exactSearch(battle, side, spec.config);
  return { choice: trace.choice, ms: Date.now() - started, scores: trace.scores };
}

export function specFromId(id: string): PolicySpec {
  switch (id) {
    case 'random':
    case 'random-v1':
      return { kind: 'random' };
    case 'maxdamage':
    case 'maxdamage-v1':
      return { kind: 'maxdamage' };
    case 'champion-v0':
      // The shipped 3-ply search. Kept as an ablation, not the fixed engine.
      return {
        kind: 'exact',
        config: { depth: 3, opponentModel: 'uniform', evalMode: 'full', errorAsLoss: true },
      };
    case 'exact-1ply':
    case 'challenger-exact-1ply':
      return { kind: 'exact', config: EXACT_1PLY };
    default:
      if (id.startsWith('exact:')) {
        const [, depth, model, evalMode] = id.split(':');
        return {
          kind: 'exact',
          config: {
            depth: Number(depth) || 1,
            opponentModel: model === 'uniform' ? 'uniform' : 'max-damage',
            evalMode: evalMode === 'full' ? 'full' : 'hp',
            errorAsLoss: false,
          },
        };
      }
      throw new Error(`Unknown policy id: ${id}`);
  }
}

export const POLICY_IDS = {
  random: 'random-v1',
  maxdamage: 'maxdamage-v1',
  exact1: 'challenger-exact-1ply',
} as const;
