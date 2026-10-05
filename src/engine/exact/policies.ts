import { Battle, PRNG } from '@pkmn/sim';
import { jevDecide } from '../../llm/jev-turn.js';
import { Action } from '../../types/index.js';
import { SideId, legalChoices } from './battle-utils.js';
import { maxDamageChoice } from './max-damage.js';
import { EXACT_1PLY, ExactConfig, SWITCH_DEPTH2, ScoredChoice, battleToState, exactSearch } from './search.js';

export type PolicySpec =
  | { kind: 'random' }
  | { kind: 'maxdamage' }
  | { kind: 'exact'; config: ExactConfig }
  | { kind: 'legacy' }
  | { kind: 'jev'; timeoutMs?: number };

export interface Decision {
  choice: string;
  ms: number;
  scores?: ScoredChoice[];
  predictedSwitch?: boolean;
  answersPredictedSwitch?: boolean;
  source?: 'jev' | 'search';
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

  if (spec.kind === 'jev') {
    const result = await jevDecide({ battle, side, timeoutMs: spec.timeoutMs });
    return { choice: result.choice ?? legal[0], ms: Date.now() - started, source: result.source };
  }

  const trace = exactSearch(battle, side, spec.config);
  return {
    choice: trace.choice,
    ms: Date.now() - started,
    scores: trace.scores,
    predictedSwitch: trace.predictedSwitch,
    answersPredictedSwitch: trace.answersPredictedSwitch,
  };
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
    case 'champion-exact-1ply':
      return { kind: 'exact', config: EXACT_1PLY };
    case 'switch-depth2':
    case 'challenger-switch-depth2':
      return { kind: 'exact', config: SWITCH_DEPTH2 };
    case 'jev':
      return { kind: 'jev' };
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
  switch2: 'challenger-switch-depth2',
} as const;

export interface ChampionBlueprint {
  id: string;
  version: string;
  title: string;
  description: string;
  config_path: string;
}

const CHAMPION_BLUEPRINTS: Record<string, ChampionBlueprint> = {
  'challenger-exact-1ply': {
    id: 'champion-exact-1ply',
    version: 'exact-1ply',
    title: 'Champion: exact 1-ply HP search',
    description: '1-ply exact @pkmn/sim battle clone. Opponent line is the accuracy-weighted max-damage move. Eight RNG draws are averaged. Eval is HP fraction plus faint counts.',
    config_path: 'src/engine/exact/search.ts',
  },
  'challenger-switch-depth2': {
    id: 'champion-switch-depth2',
    version: 'switch-depth2',
    title: 'Champion: depth-2 switch search',
    description: 'Depth-2 exact battle clone. Opponent replies mix staying to attack and switching, fit on high-Elo replays. Eval scores both teams. Every legal switch is scored at the root.',
    config_path: 'experiments/switch-depth2/config.json',
  },
};

export function championBlueprint(challengerId: string): ChampionBlueprint {
  return CHAMPION_BLUEPRINTS[challengerId] || {
    id: `champion-${challengerId}`,
    version: challengerId,
    title: `Champion: ${challengerId}`,
    description: 'Promoted through the gate.',
    config_path: 'src/engine/exact/search.ts',
  };
}
