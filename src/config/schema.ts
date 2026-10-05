import { z } from 'zod';
import {
  DEFAULT_REVIEWER_MODEL_ID,
  JEV_MODEL_ID,
} from '../llm/models.js';

export const MACRO_STYLES = ['balanced', 'hyper-offense', 'attrition', 'hazard-stack', 'setup-sweeper'] as const;
export type MacroStyle = (typeof MACRO_STYLES)[number];

export const CONTEXT_BLOCK_IDS = [
  'board',
  'calc-sheet',
  'opponent-sets',
  'revealed-history',
  'opponent-tendencies',
  'field',
  'search-top-k',
  'game-plan',
  'expert-tips',
  'position-memory',
] as const;
export type ContextBlockId = (typeof CONTEXT_BLOCK_IDS)[number];

export const EVAL_TERMS = [
  'hpDifference',
  'monCount',
  'hazards',
  'speedOption',
  'teraAvailability',
  'status',
  'boosts',
  'winConditionHealth',
  'preservation',
] as const;
export type EvalTerm = (typeof EVAL_TERMS)[number];

export const WeightsSchema = z.object({
  hpDifference: z.number().default(1),
  monCount: z.number().default(2),
  hazards: z.number().default(0),
  speedOption: z.number().default(0),
  teraAvailability: z.number().default(0),
  status: z.number().default(0),
  boosts: z.number().default(0),
  winConditionHealth: z.number().default(0),
  preservation: z.number().default(0),
}).strict();
export type Weights = z.infer<typeof WeightsSchema>;

export const AgentParamsSchema = z.object({
  style: z.enum(MACRO_STYLES).default('balanced'),
  preview: z.enum(['off', 'heuristic', 'llm']).default('heuristic'),
}).strict();
export type AgentParams = z.infer<typeof AgentParamsSchema>;

export const SearchParamsSchema = z.object({
  depth: z.number().int().min(1).max(3).default(1),
  samples: z.number().int().min(1).max(16).default(1),
  timeBudgetMs: z.number().int().positive().default(2000),
  risk: z.enum(['expected-value', 'minimax', 'risk-averse']).default('expected-value'),
  variancePenalty: z.number().nonnegative().default(0),
  opponentModel: z.enum(['max-damage', 'uniform']).default('max-damage'),
  evalMode: z.enum(['hp', 'full']).default('hp'),
  /**
   * Opt-in foe set prior for exact-1ply-qw (see engine/exact/stats-prior.ts).
   * Unset keeps QW's first-matching-set move fill and existing config ids.
   * moves: role-posterior move fill. items: + posterior-mode hidden item.
   * full: + posterior-mode hidden ability.
   */
  foeStats: z.enum(['off', 'moves', 'items', 'full']).optional(),
  /**
   * Opt-in: placeholder fills unseen foe teammates up to six in the decision
   * battle, so KOing the last revealed foe is not scored as a won game.
   * Unset keeps the revealed-only foe team and existing config ids.
   */
  foeUnseen: z.enum(['revealed', 'placeholder']).optional(),
  /**
   * Opt-in endgame deepening for exact-1ply-qw: search endgameDepth plies
   * once at most endgameMons mons remain on both sides combined (unrevealed
   * foes count as alive). Unset keeps the configured depth and config ids.
   */
  endgameMons: z.number().int().min(2).max(12).optional(),
  endgameDepth: z.number().int().min(2).max(3).optional(),
  /**
   * Opt-in simultaneous-move solve for exact-1ply-qw: a matrix of own
   * choices x up to replySolveReplies foe replies, solved as a zero-sum
   * game. replySolveNashWeight blends the foe's equilibrium mix (1) with the
   * modelled reply (0). Unset keeps the single modelled reply and config ids.
   */
  replySolveReplies: z.number().int().min(2).max(10).optional(),
  replySolveSamples: z.number().int().min(1).max(16).optional(),
  replySolveNashWeight: z.number().min(0).max(1).optional(),
  /**
   * Opt-in foe reply model for exact-1ply-qw: 'switch' uses the fitted
   * switch model (switch-model.ts: P(switch) x ranked switches + damage-
   * weighted moves, top replySwitchMax kept). Unset keeps the behavior
   * layer's model (max-damage) and every existing config id.
   */
  replyModel: z.enum(['switch']).optional(),
  replySwitchMax: z.number().int().min(1).max(6).optional(),
  /**
   * Opt-in belief tightening for exact-1ply-qw (client/foe-belief.ts): the
   * decision battle's revealed foes get moves, hidden item and hidden ability
   * from the SetInference posterior (speed order, damage rolls, hard filters,
   * weather duration). Unset keeps the revealed-only foe and every config id.
   */
  foeBelief: z.boolean().optional(),
}).strict();
export type SearchParams = z.infer<typeof SearchParamsSchema>;

export const EvaluatorParamsSchema = z.object({
  weights: WeightsSchema.default({}),
}).strict();
export type EvaluatorParams = z.infer<typeof EvaluatorParamsSchema>;

export const SetInferenceParamsSchema = z.object({
  minRoleWeight: z.number().min(0).max(1).default(0),
  maxCandidates: z.number().int().positive().default(12),
}).strict();
export type SetInferenceParams = z.infer<typeof SetInferenceParamsSchema>;

export const CategoryPriorsSchema = z.object({
  physical: z.number().nonnegative().default(1),
  special: z.number().nonnegative().default(1),
  status: z.number().nonnegative().default(1),
  hazard: z.number().nonnegative().default(1),
  setup: z.number().nonnegative().default(1),
  priority: z.number().nonnegative().default(1),
  switch: z.number().nonnegative().default(1),
}).strict();
export type CategoryPriors = z.infer<typeof CategoryPriorsSchema>;

export const BehaviorParamsSchema = z.object({
  switchWeight: z.number().positive().default(1),
  ratingConditioned: z.boolean().default(false),
  priors: CategoryPriorsSchema.default({}),
}).strict();
export type BehaviorParams = z.infer<typeof BehaviorParamsSchema>;

export const PolicyParamsSchema = z.object({
  enabled: z.boolean().default(true),
}).strict();
export type PolicyParams = z.infer<typeof PolicyParamsSchema>;

export const ContextBlockSchema = z.object({
  id: z.enum(CONTEXT_BLOCK_IDS),
  enabled: z.boolean(),
  format: z.enum(['prose', 'table', 'json']),
  tokenBudget: z.number().int().positive(),
  priority: z.number().int(),
}).strict();
export type ContextBlock = z.infer<typeof ContextBlockSchema>;

export const ContextParamsSchema = z.object({
  globalTokenBudget: z.number().int().positive().default(4000),
  blocks: z.array(ContextBlockSchema).min(1),
}).strict();
export type ContextParams = z.infer<typeof ContextParamsSchema>;

export const AdvisorParamsSchema = z.object({
  enabled: z.boolean().default(false),
  questions: z.object({
    bestAction: z.boolean().default(true),
    opponentWillSwitch: z.boolean().default(true),
    score: z.boolean().default(true),
  }).strict().default({}),
  blend: z.enum(['off', 'prior', 'tiebreak', 'veto-blunders']).default('off'),
  weight: z.number().min(0).max(1).default(0.15),
  tieEpsilon: z.number().nonnegative().default(0.05),
  topK: z.number().int().positive().default(8),
  trigger: z.object({
    mode: z.enum(['always', 'gap', 'critical']).default('always'),
    gap: z.number().nonnegative().default(1),
  }).strict().default({}),
  latencyBudgetMs: z.number().int().positive().default(1500),
  blunderThreshold: z.number().min(0).max(1).default(0.25),
}).strict();
export type AdvisorParams = z.infer<typeof AdvisorParamsSchema>;

const RoleChainSchema = z.object({
  models: z.array(z.string().min(1)).min(1),
  costCapUsd: z.number().nonnegative(),
}).strict();
export type RoleChain = z.infer<typeof RoleChainSchema>;

export const MODEL_ROLES = ['turnAdvisor', 'teamPreviewPlanner', 'lossReviewer', 'hypothesisGenerator'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export const ModelsParamsSchema = z.object({
  roles: z.object({
    turnAdvisor: RoleChainSchema,
    teamPreviewPlanner: RoleChainSchema,
    lossReviewer: RoleChainSchema,
    hypothesisGenerator: RoleChainSchema,
  }).strict(),
}).strict();
export type ModelsParams = z.infer<typeof ModelsParamsSchema>;

export const PhasePatchSchema = z.object({
  agentId: z.string().min(1).optional(),
  searchDepth: z.number().int().min(1).max(3).optional(),
}).strict();
export type PhasePatch = z.infer<typeof PhasePatchSchema>;

export const MetaParamsSchema = z.object({
  openingTurns: z.number().int().min(0).default(2),
  endgameMons: z.number().int().min(1).default(2),
  phases: z.object({
    opening: PhasePatchSchema.optional(),
    mid: PhasePatchSchema.optional(),
    endgame: PhasePatchSchema.optional(),
  }).strict().default({}),
  archetypes: z.record(PhasePatchSchema).default({}),
  ratingBands: z.array(z.object({
    min: z.number(),
    max: z.number(),
    agentId: z.string().optional(),
    searchDepth: z.number().int().min(1).max(3).optional(),
  }).strict()).default([]),
}).strict();
export type MetaParams = z.infer<typeof MetaParamsSchema>;

export const RefSchema = z.object({
  id: z.string().min(1).optional(),
  params: z.record(z.unknown()).optional(),
}).strict();

export const PoliciesSchema = z.object({
  teraPolicy: RefSchema,
  hazardPolicy: RefSchema,
  sacPolicy: RefSchema,
  switchPolicy: RefSchema,
  leadPolicy: RefSchema,
  endgamePolicy: RefSchema,
}).strict();

export const RawConfigSchema = z.object({
  name: z.string().min(1).optional(),
  extends: z.union([z.string(), z.array(z.string())]).optional(),
  agent: RefSchema.optional(),
  search: RefSchema.optional(),
  evaluator: RefSchema.optional(),
  opponentModel: z.object({
    setInference: RefSchema.optional(),
    behavior: RefSchema.optional(),
  }).strict().optional(),
  policies: z.object({
    teraPolicy: RefSchema.optional(),
    hazardPolicy: RefSchema.optional(),
    sacPolicy: RefSchema.optional(),
    switchPolicy: RefSchema.optional(),
    leadPolicy: RefSchema.optional(),
    endgamePolicy: RefSchema.optional(),
  }).strict().optional(),
  context: RefSchema.optional(),
  advisor: RefSchema.optional(),
  models: RefSchema.optional(),
  metaController: RefSchema.optional(),
}).strict();
export type RawConfig = z.infer<typeof RawConfigSchema>;

export interface ComponentRef<P> {
  id: string;
  params: P;
}

export interface ResolvedConfig {
  schemaVersion: 1;
  name: string;
  agent: ComponentRef<AgentParams>;
  search: ComponentRef<SearchParams>;
  evaluator: ComponentRef<EvaluatorParams>;
  opponentModel: {
    setInference: ComponentRef<SetInferenceParams>;
    behavior: ComponentRef<BehaviorParams>;
  };
  policies: {
    teraPolicy: ComponentRef<PolicyParams>;
    hazardPolicy: ComponentRef<PolicyParams>;
    sacPolicy: ComponentRef<PolicyParams>;
    switchPolicy: ComponentRef<PolicyParams>;
    leadPolicy: ComponentRef<PolicyParams>;
    endgamePolicy: ComponentRef<PolicyParams>;
  };
  context: ComponentRef<ContextParams>;
  advisor: ComponentRef<AdvisorParams>;
  models: ComponentRef<ModelsParams>;
  metaController: ComponentRef<MetaParams>;
}

export const FRONTIER_CHAT = [DEFAULT_REVIEWER_MODEL_ID, 'anthropic/claude-opus-5.5', 'openai/gpt-6.1-sol'];

export function defaultBlocks(): ContextBlock[] {
  const order: Array<[ContextBlockId, number, 'prose' | 'table' | 'json']> = [
    ['calc-sheet', 100, 'prose'],
    ['board', 90, 'prose'],
    ['search-top-k', 80, 'table'],
    ['game-plan', 70, 'prose'],
    ['field', 60, 'prose'],
    ['opponent-sets', 50, 'json'],
    ['revealed-history', 40, 'prose'],
    ['opponent-tendencies', 30, 'prose'],
    ['expert-tips', 20, 'prose'],
    ['position-memory', 10, 'prose'],
  ];
  return order.map(([id, priority, format]) => ({
    id,
    enabled: true,
    format,
    tokenBudget: 500,
    priority,
  }));
}

export function defaultModelRoles(): ModelsParams['roles'] {
  return {
    turnAdvisor: { models: [JEV_MODEL_ID], costCapUsd: 0.05 },
    teamPreviewPlanner: { models: [...FRONTIER_CHAT], costCapUsd: 0.25 },
    lossReviewer: { models: [...FRONTIER_CHAT], costCapUsd: 0.5 },
    hypothesisGenerator: { models: [DEFAULT_REVIEWER_MODEL_ID, 'openai/gpt-6.1-sol'], costCapUsd: 0.25 },
  };
}

export function defaultWeights(patch: Partial<Weights> = {}): Weights {
  return WeightsSchema.parse(patch);
}
