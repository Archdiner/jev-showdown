import { deepMerge } from './merge.js';
import {
  defaultBlocks,
  defaultModelRoles,
  defaultWeights,
  type RawConfig,
} from './schema.js';

function ref(id: string, params: Record<string, unknown> = {}): { id: string; params: Record<string, unknown> } {
  return { id, params };
}

function policies(id: 'off' | 'heuristic', enabled = id === 'heuristic') {
  const one = ref(id, { enabled });
  return {
    teraPolicy: one,
    hazardPolicy: { ...one, params: { ...one.params } },
    sacPolicy: { ...one, params: { ...one.params } },
    switchPolicy: { ...one, params: { ...one.params } },
    leadPolicy: { ...one, params: { ...one.params } },
    endgamePolicy: { ...one, params: { ...one.params } },
  };
}

/** Champion strategy. Every other agent bundle starts from this and overrides. */
export function balancedRaw(name = 'balanced'): RawConfig {
  return {
    name,
    agent: ref('balanced', { style: 'balanced', preview: 'heuristic' }),
    search: ref('greedy-1ply', {
      depth: 1,
      samples: 1,
      timeBudgetMs: 2000,
      risk: 'expected-value',
      variancePenalty: 0,
      opponentModel: 'max-damage',
      evalMode: 'hp',
    }),
    evaluator: ref('hp-fraction', { weights: defaultWeights() }),
    opponentModel: {
      setInference: ref('loose', { minRoleWeight: 0, maxCandidates: 12 }),
      behavior: ref('max-damage', {
        switchWeight: 1,
        ratingConditioned: false,
        priors: { physical: 1, special: 1, status: 1, hazard: 1, setup: 1, priority: 1, switch: 1 },
      }),
    },
    policies: policies('off', false),
    context: ref('blocks', { globalTokenBudget: 4000, blocks: defaultBlocks() }),
    advisor: ref('jev', {
      enabled: false,
      questions: { bestAction: true, opponentWillSwitch: true, score: true },
      blend: 'off',
      weight: 0.15,
      tieEpsilon: 0.05,
      topK: 8,
      trigger: { mode: 'always', gap: 1 },
      latencyBudgetMs: 1500,
      blunderThreshold: 0.25,
    }),
    models: ref('catalog', { roles: defaultModelRoles() }),
    metaController: ref('static', {
      openingTurns: 2,
      endgameMons: 2,
      phases: {},
      archetypes: {},
      ratingBands: [],
    }),
  };
}

export function agentBundle(id: string): RawConfig {
  if (id === 'balanced') return balancedRaw('balanced');
  if (id === 'hyper-offense') {
    return deepMerge(balancedRaw('hyper-offense'), {
      agent: ref('hyper-offense', { style: 'hyper-offense', preview: 'heuristic' }),
      evaluator: ref('weighted', {
        weights: defaultWeights({
          hpDifference: 0.6,
          monCount: 0.4,
          hazards: 0.2,
          speedOption: 0.5,
          teraAvailability: 0.8,
          boosts: 1,
          winConditionHealth: 1,
          preservation: 0.1,
        }),
      }),
      policies: {
        ...policies('off', false),
        teraPolicy: ref('heuristic', { enabled: true }),
        sacPolicy: ref('heuristic', { enabled: true }),
      },
    });
  }
  if (id === 'attrition') {
    return deepMerge(balancedRaw('attrition'), {
      agent: ref('attrition', { style: 'attrition', preview: 'heuristic' }),
      evaluator: ref('weighted', {
        weights: defaultWeights({
          hpDifference: 1,
          monCount: 1.5,
          hazards: 1,
          speedOption: 0.8,
          status: 0.4,
          preservation: 1.2,
          winConditionHealth: 0.8,
        }),
      }),
      policies: {
        ...policies('off', false),
        switchPolicy: ref('heuristic', { enabled: true }),
        hazardPolicy: ref('heuristic', { enabled: true }),
      },
    });
  }
  if (id === 'hazard-stack') {
    return deepMerge(balancedRaw('hazard-stack'), {
      agent: ref('hazard-stack', { style: 'hazard-stack', preview: 'heuristic' }),
      evaluator: ref('weighted', {
        weights: defaultWeights({ hazards: 1.5, hpDifference: 0.8, monCount: 1, speedOption: 0.3 }),
      }),
      policies: {
        ...policies('off', false),
        hazardPolicy: ref('heuristic', { enabled: true }),
        leadPolicy: ref('heuristic', { enabled: true }),
      },
    });
  }
  if (id === 'setup-sweeper') {
    return deepMerge(balancedRaw('setup-sweeper'), {
      agent: ref('setup-sweeper', { style: 'setup-sweeper', preview: 'heuristic' }),
      evaluator: ref('weighted', {
        weights: defaultWeights({
          boosts: 1.2,
          winConditionHealth: 1,
          preservation: 0.9,
          speedOption: 0.6,
          hpDifference: 0.7,
        }),
      }),
      policies: {
        ...policies('off', false),
        leadPolicy: ref('heuristic', { enabled: true }),
        endgamePolicy: ref('heuristic', { enabled: true }),
      },
    });
  }
  throw new Error(`No agent bundle for "${id}"`);
}
