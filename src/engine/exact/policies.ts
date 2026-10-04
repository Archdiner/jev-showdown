import { Battle, PRNG } from '@pkmn/sim';
import { Action } from '../../types/index.js';
import { SideId, legalChoices } from './battle-utils.js';
import { maxDamageChoice } from './max-damage.js';
import { EXACT_1PLY, ExactConfig, ScoredChoice, battleToState, exactSearch } from './search.js';

export type PolicySpec =
  | { kind: 'random' }
  | { kind: 'maxdamage' }
  | { kind: 'exact'; config: ExactConfig }
  | { kind: 'legacy' };

export interface Decision {
  choice: string;
  ms: number;
  scores?: ScoredChoice[];
}

export async function decide(spec: PolicySpec, battle: Battle, side: SideId, rng: PRNG): Promise<Decision> {
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

  if (spec.kind === 'legacy') {
    const choice = await legacyChoice(battle, side, legal);
    return { choice, ms: Date.now() - started };
  }

  const trace = exactSearch(battle, side, spec.config);
  return { choice: trace.choice, ms: Date.now() - started, scores: trace.scores };
}

let legacySearch: { search: (state: any, actions: Action[]) => Promise<Action> } | null = null;

async function legacyChoice(battle: Battle, side: SideId, legal: string[]): Promise<string> {
  if (!legacySearch) {
    const { RobustSearch } = await import('../robust-search.js');
    const { Evaluator } = await import('../evaluator.js');
    const { gen9RandomBattle } = await import('../../formats/gen9-randombattle.js');
    legacySearch = new RobustSearch({
      searchTimeMs: 1200,
      searchIterations: 100,
      explorationConstant: 1.4,
      sampledWorlds: 4,
      useTeraHeuristic: false,
      useLLMPrior: false,
    }, new Evaluator(), gen9RandomBattle);
  }
  const actions = legal.map(choiceToAction);
  const action = await legacySearch.search(battleToState(battle, side), actions);
  const choice = actionToChoice(action);
  return legal.includes(choice) ? choice : legal[0];
}

function choiceToAction(choice: string): Action {
  if (choice.startsWith('switch')) return { type: 'switch', switchIndex: Number(choice.slice(7)) };
  return { type: 'move', moveIndex: Number(choice.slice(5)) };
}

function actionToChoice(action: Action): string {
  if (action.type === 'switch') return `switch ${action.switchIndex}`;
  return `move ${action.moveIndex}`;
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
    case 'legacy':
      // Historical 3-ply search that rebuilds a battle from scratch each node.
      return { kind: 'legacy' };
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
