import { PRNG, type Battle } from '@pkmn/sim';
import { battleWithFoePriors, foePriorsApplyInDecide } from '../client/decision-battle.js';
import { legalChoices, type SideId } from '../engine/exact/battle-utils.js';
import { randbatsForPriors } from '../engine/foe-prior.js';
import { battleToState } from '../engine/exact/search.js';
import { blendCandidates } from '../llm/blend.js';
import { toAdvisorCandidates } from '../llm/state-summary.js';
import { GatewayClient } from '../llm/gateway-client.js';
import type { LossReviewer, ReviewResult } from '../llm/loss-reviewer.js';
import { dataLoader } from '../data/data-loader.js';
import type { Action } from '../types/index.js';
import { configIdOf } from './hash.js';
import { resolveEnv, type EnvName, type EnvProfile } from './env.js';
import type {
  AttributedDecision,
  BotSpec,
  DecisionInput,
  GamePlan,
  LayerIds,
  RuntimeCaps,
} from './interfaces.js';
import type { AgentImpl } from './layers/agent.js';
import { heuristicPlan } from './layers/agent.js';
import type { AdvisorImpl } from './layers/advisor.js';
import { aliveCount, boostSum, hpFrac, otherSide } from './layers/battle.js';
import type { ContextImpl } from './layers/context.js';
import type { EvalImpl } from './layers/evaluator.js';
import { ensureLayers } from './layers/index.js';
import type { MetaAdjustment, MetaImpl } from './layers/meta.js';
import type { ModelsImpl } from './layers/models.js';
import type { BehaviorImpl, SetInferenceImpl } from './layers/opponent.js';
import type { PolicyImpl } from './layers/policies.js';
import type { SearchImpl } from './layers/search.js';
import { createLogger, type DecisionLogger, type GameLogRecord } from './log.js';
import { isBotSpec, layerIdsOf, loadConfig, resolveRaw, type LoadedConfig } from './load.js';
import { createComponent } from './registry.js';
import type { RawConfig, ResolvedConfig } from './schema.js';

export interface BuildOverrides {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface BuiltBot {
  configId: string;
  config: ResolvedConfig;
  layerIds: LayerIds;
  env: EnvProfile;
  runtime: RuntimeCaps;
  logger: DecisionLogger;
  decide(input: DecisionInput): Promise<AttributedDecision>;
  reviewLoss(text: string, opts?: Parameters<LossReviewer['review']>[1]): Promise<ReviewResult>;
  beginGame(game: { gameId: string; seed: number; opponentConfigId?: string }): void;
  endGame(game: Omit<GameLogRecord, 'ts' | 'kind' | 'configId' | 'layerIds' | 'env' | 'gameId' | 'seed'> & { gameId?: string }): void;
}

export type ConfigSource = string | BotSpec | LoadedConfig | RawConfig;

/** Search must stop at the tighter of the config budget and the env profile cap. */
export function searchDeadline(now: number, timeBudgetMs: number, timeLimitMs: number): number {
  return now + Math.min(timeBudgetMs, timeLimitMs);
}

export function buildBot(source: ConfigSource, env?: EnvName | EnvProfile, overrides: BuildOverrides = {}): BuiltBot {
  ensureLayers();
  const loaded = materializeSource(source);
  const named = resolveEnv(env ?? (isBotSpec(source) ? source.env : 'selfplay'));
  const cap = isBotSpec(source) ? source.llmCostCapUsd : undefined;
  const profile = cap == null ? named : {
    ...named,
    llm: { allowed: named.llm.allowed, costCapUsd: Math.min(named.llm.costCapUsd, cap) },
  };
  const runtime = runtimeOf(profile, loaded.config);
  const base = implsOf(loaded.config);
  const logger = createLogger(profile);
  const client = new GatewayClient({
    apiKey: overrides.apiKey,
    fetchImpl: overrides.fetchImpl,
    timeoutMs: Math.min(loaded.config.advisor.params.latencyBudgetMs, profile.timeLimitMs),
    perTurnLatencyBudgetMs: Math.min(loaded.config.advisor.params.latencyBudgetMs, profile.timeLimitMs),
    maxRetries: overrides.fetchImpl ? 0 : undefined,
    log: overrides.log ?? (profile.logSink === 'memory' ? () => undefined : undefined),
  });
  const spend: Record<string, number> = {};
  let current: { gameId: string; seed: number; opponentConfigId?: string } | undefined;
  const layerIds = layerIdsOf(loaded.config);

  const bot: BuiltBot = {
    configId: loaded.configId,
    config: loaded.config,
    layerIds,
    env: profile,
    runtime,
    logger,
    beginGame(game) {
      current = game;
    },
    endGame(game) {
      logger.game({
        ts: Date.now(),
        kind: 'game',
        gameId: game.gameId || current?.gameId || 'game',
        seed: current?.seed ?? 0,
        configId: loaded.configId,
        layerIds,
        env: profile.name,
        opponentConfigId: current?.opponentConfigId,
        winner: game.winner,
        turns: game.turns,
        invalid: game.invalid,
        situations: game.situations,
      });
    },
    async reviewLoss(text, opts) {
      const model = loaded.config.models.params.roles.lossReviewer.models[0];
      if (!runtime.llmAllowed) return { ok: false, error: 'llm_disabled_by_env', model };
      return base.models.reviewer(client).review(text, opts);
    },
    async decide(input) {
      const started = Date.now();
      const rng = input.rng ?? new PRNG([1, 2, 3, 4] as never);
      const adjustment = base.meta.select({ battle: input.battle, side: input.side, rating: input.rating });
      const activeConfig = applyAdjustment(loaded.config, adjustment);
      const active = activeConfig === loaded.config ? base : implsOf(activeConfig);
      const activeLayerIds = layerIdsOf(activeConfig);
      const plan = await planFor(active, activeConfig, input, client, spend, runtime);
      const legal = legalChoices(input.battle, input.side);
      const budget = Math.min(activeConfig.search.params.timeBudgetMs, runtime.timeLimitMs);
      const priorStats = legal.length > 0 && foePriorsApplyInDecide(input.battle, activeConfig.search.params.foePriors, input.variantId)
        ? randbatsForPriors()
        : null;
      const modeled = priorStats ? battleWithFoePriors(input.battle, input.side, priorStats) : null;
      const trace = legal.length === 0
        ? { choice: 'default', scores: [] as Array<{ choice: string; score: number }>, predictedSwitch: undefined, answersPredictedSwitch: undefined }
        : await active.search.search(modeled || input.battle, modeled ? 'p1' : input.side, {
          evaluate: active.evaluate,
          behavior: active.behavior,
          plan,
          rng,
          rating: input.rating,
          variantId: input.variantId,
          deadlineMs: searchDeadline(Date.now(), activeConfig.search.params.timeBudgetMs, runtime.timeLimitMs),
        });
      let scores = trace.scores.length ? trace.scores : [{ choice: trace.choice, score: 0 }];
      let choice = applyPolicies(active, input.battle, input.side, legal, plan, scores);
      if (modeled && choice !== 'default' && !legal.includes(choice)) {
        const again = await active.search.search(input.battle, input.side, {
          evaluate: active.evaluate,
          behavior: active.behavior,
          plan,
          rng,
          rating: input.rating,
          variantId: input.variantId,
          deadlineMs: searchDeadline(Date.now(), activeConfig.search.params.timeBudgetMs, runtime.timeLimitMs),
        });
        scores = again.scores.length ? again.scores : [{ choice: again.choice, score: 0 }];
        choice = applyPolicies(active, input.battle, input.side, legal, plan, scores);
      }
      scores = scores.map(row => ({ ...row, score: row.score }));
      let advisorCalled = false;
      let advisorSource: string | undefined;
      if (shouldAdvise(activeConfig, runtime, spend, input.battle, input.side, scores)) {
        const advised = await advise(active, client, input, plan, scores, spend, runtime);
        if (advised && legal.includes(advised.choice)) {
          choice = advised.choice;
          advisorCalled = true;
          advisorSource = advised.source;
        }
      }
      const ms = Date.now() - started;
      active.context.remember(input.battle, input.side, choice);
      const decision: AttributedDecision = {
        choice,
        configId: loaded.configId,
        layerIds,
        activeLayerIds,
        scores,
        ms,
        advisorCalled,
        advisorSource,
        overBudget: ms > budget,
        gamePlan: plan,
        predictedSwitch: trace.predictedSwitch,
        answersPredictedSwitch: trace.answersPredictedSwitch,
        variantId: input.variantId,
      };
      logger.decision({
        ts: Date.now(),
        kind: 'decision',
        configId: loaded.configId,
        layerIds,
        activeLayerIds,
        env: profile.name,
        gameId: input.gameId || current?.gameId,
        seed: input.seed ?? current?.seed,
        turn: input.battle.turn,
        side: input.side,
        choice,
        scores: scores.slice(0, 8),
        ms,
        advisorCalled,
        overBudget: decision.overBudget,
        variantId: input.variantId,
      });
      return decision;
    },
  };
  return bot;
}

interface Impls {
  agent: AgentImpl;
  search: SearchImpl;
  evaluate: EvalImpl;
  setInference: SetInferenceImpl;
  behavior: BehaviorImpl;
  policies: PolicyImpl[];
  context: ContextImpl;
  advisor: AdvisorImpl;
  models: ModelsImpl;
  meta: MetaImpl;
}

function implsOf(config: ResolvedConfig): Impls {
  const policies = config.policies;
  return {
    agent: createComponent('agent', config.agent.id, config.agent.params),
    search: createComponent('search', config.search.id, config.search.params),
    evaluate: createComponent('evaluator', config.evaluator.id, config.evaluator.params),
    setInference: createComponent('setInference', config.opponentModel.setInference.id, config.opponentModel.setInference.params),
    behavior: createComponent('behavior', config.opponentModel.behavior.id, config.opponentModel.behavior.params),
    policies: (Object.keys(policies) as Array<keyof typeof policies>).map(key =>
      createComponent('' + key, policies[key].id, policies[key].params)
    ),
    context: createComponent('context', config.context.id, config.context.params),
    advisor: createComponent('advisor', config.advisor.id, config.advisor.params),
    models: createComponent('models', config.models.id, config.models.params),
    meta: createComponent('metaController', config.metaController.id, config.metaController.params),
  };
}

function applyAdjustment(config: ResolvedConfig, adjustment: MetaAdjustment): ResolvedConfig {
  if (!adjustment.agentId && adjustment.searchDepth == null) return config;
  let next = config;
  if (adjustment.agentId && adjustment.agentId !== config.agent.id) {
    next = resolveRaw({ name: config.name, agent: { id: adjustment.agentId } }, config.name).config;
  }
  if (adjustment.searchDepth != null) {
    next = {
      ...next,
      search: { ...next.search, params: { ...next.search.params, depth: adjustment.searchDepth } },
    };
  }
  return next;
}

function applyPolicies(
  impl: Impls,
  battle: Battle,
  side: SideId,
  legal: string[],
  plan: GamePlan | null,
  scores: Array<{ choice: string; score: number }>
): string {
  if (legal.length === 0) return 'default';
  if (legal.length === 1) return legal[0];
  const bias: Record<string, number> = {};
  let override: string | undefined;
  for (const policy of impl.policies) {
    const effect = policy.apply({ battle, side, legal, plan });
    if (effect.override && legal.includes(effect.override)) override = effect.override;
    for (const [choice, value] of Object.entries(effect.bias ?? {})) {
      if (legal.includes(choice)) bias[choice] = (bias[choice] || 0) + value;
    }
  }
  if (override) return override;
  let best = scores.find(row => legal.includes(row.choice))?.choice ?? legal[0];
  let bestScore = -Infinity;
  const ranked = scores.filter(row => legal.includes(row.choice));
  const rows = ranked.length ? ranked : legal.map(choice => ({ choice, score: 0 }));
  for (const row of rows) {
    const score = row.score + (bias[row.choice] || 0);
    if (score > bestScore) {
      bestScore = score;
      best = row.choice;
    }
  }
  return best;
}

function shouldAdvise(
  config: ResolvedConfig,
  runtime: RuntimeCaps,
  spend: Record<string, number>,
  battle: Battle,
  side: SideId,
  scores: Array<{ choice: string; score: number }>
): boolean {
  const params = config.advisor.params;
  if (!params.enabled || params.blend === 'off' || !runtime.llmAllowed) return false;
  if ((spend.turnAdvisor || 0) >= Math.min(config.models.params.roles.turnAdvisor.costCapUsd, runtime.llmCostCapUsd)) {
    return false;
  }
  if (params.trigger.mode === 'always') return true;
  if (params.trigger.mode === 'critical') return isCritical(battle, side);
  const ordered = [...scores].sort((a, b) => b.score - a.score);
  if (ordered.length < 2) return false;
  return ordered[0].score - ordered[1].score < params.trigger.gap;
}

function isCritical(battle: Battle, side: SideId): boolean {
  const active = battle.getSide(side).active[0];
  if (!active || hpFrac(active) < 0.3) return true;
  if (aliveCount(battle, side) <= 2 || aliveCount(battle, otherSide(side)) <= 2) return true;
  return boostSum(battle.getSide(otherSide(side)).active[0]) >= 2;
}

async function advise(
  impl: Impls,
  client: GatewayClient,
  input: DecisionInput,
  plan: GamePlan | null,
  scores: Array<{ choice: string; score: number }>,
  spend: Record<string, number>,
  runtime: RuntimeCaps
): Promise<{ choice: string; source: string } | null> {
  const blend = impl.advisor.blendConfig();
  const state = battleToState(input.battle, input.side);
  const scored = scores.map(row => ({ action: choiceToAction(row.choice), searchScore: row.score }));
  const candidates = toAdvisorCandidates(scored, blend.topK);
  const rendered = impl.context.render({
    battle: input.battle,
    side: input.side,
    plan,
    scores,
    behaviorId: impl.behavior.id,
    rating: input.rating,
    setInference: impl.setInference,
    memory: impl.context.memory,
  });
  client.startTurn();
  try {
    const assessment = await impl.models.advisor(client).advise(state, candidates, pools(), {
      contextText: rendered.text,
      facts: rendered.facts,
      questions: impl.advisor.params.questions,
    });
    spend.turnAdvisor = (spend.turnAdvisor || 0) + assessment.costUsd;
    if (runtime.llmCostCapUsd <= 0 && assessment.costUsd > 0) return null;
    const blended = blendCandidates(candidates, assessment, blend);
    const winner = blended.ranked[0];
    if (!winner) return null;
    return { choice: actionToChoice(winner.action), source: blended.source };
  } finally {
    client.endTurn();
  }
}

async function planFor(
  impl: Impls,
  config: ResolvedConfig,
  input: DecisionInput,
  client: GatewayClient,
  spend: Record<string, number>,
  runtime: RuntimeCaps
): Promise<GamePlan | null> {
  const heuristic = impl.agent.preview(input.battle, input.side);
  if (config.agent.params.preview !== 'llm' || !runtime.llmAllowed) return heuristic;
  const team = input.battle.getSide(input.side).pokemon.map(mon => mon.species?.name).filter(Boolean);
  const result = await impl.models.complete(
    client,
    'teamPreviewPlanner',
    [
      { role: 'system', content: 'Pick a win condition and which teammates to preserve. Answer with JSON keys winCondition and preserve. Use roles such as speed, bulk, and offense. Do not invent a species-specific rule.' },
      { role: 'user', content: `style ${config.agent.params.style}\nteam ${team.join(', ')}` },
    ],
    spend,
    runtime.llmCostCapUsd
  );
  if (!result) return heuristic;
  try {
    const parsed = JSON.parse(result.text) as { winCondition?: string; preserve?: string[] };
    if (!parsed.winCondition || !Array.isArray(parsed.preserve)) return heuristic;
    return {
      style: config.agent.params.style,
      winCondition: parsed.winCondition,
      preserve: parsed.preserve.map(String),
      notes: heuristic?.notes || 'planner',
    };
  } catch {
    return heuristic ?? heuristicPlan(input.battle, input.side, config.agent.params.style);
  }
}

function runtimeOf(env: EnvProfile, config: ResolvedConfig): RuntimeCaps {
  return {
    timeLimitMs: Math.min(env.timeLimitMs, config.search.params.timeBudgetMs),
    network: env.network,
    logSink: env.logSink,
    llmAllowed: env.llm.allowed,
    llmCostCapUsd: env.llm.costCapUsd,
  };
}

function materializeSource(source: ConfigSource): LoadedConfig {
  if (typeof source === 'string') return loadConfig(source);
  if (isBotSpec(source)) {
    const id = configIdOfSafe(source);
    if (id !== source.configId) {
      throw new Error(`configId mismatch for ${source.config.name}: stored ${source.configId}, content ${id}`);
    }
    return { configId: source.configId, config: source.config };
  }
  if (isLoaded(source)) return source;
  return resolveRaw(source, source.name || 'config');
}

function isLoaded(value: ConfigSource): value is LoadedConfig {
  return Boolean(value && typeof value === 'object' && 'configId' in value && 'config' in value && !('env' in value));
}

function configIdOfSafe(spec: BotSpec): string {
  return configIdOf(spec.config);
}

function choiceToAction(choice: string): Action {
  if (choice.startsWith('switch ')) return { type: 'switch', switchIndex: Number(choice.split(' ')[1]) };
  const parts = choice.split(' ');
  return { type: 'move', moveIndex: Number(parts[1]), terastallize: parts.includes('terastallize') };
}

function actionToChoice(action: Action): string {
  if (action.type === 'switch') return `switch ${action.switchIndex}`;
  return action.terastallize ? `move ${action.moveIndex} terastallize` : `move ${action.moveIndex}`;
}

function pools() {
  try {
    return dataLoader.getStats();
  } catch {
    return {};
  }
}
