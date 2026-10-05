import type { Battle, PRNG } from '@pkmn/sim';
import {
  cloneFromSnapshot,
  legalChoices,
  playChoices,
  snapshot,
  type SideId,
} from '../../engine/exact/battle-utils.js';
import { maxDamageChoice } from '../../engine/exact/max-damage.js';
import { decide as legacyDecide } from '../../engine/exact/policies.js';
import { exactSearch, searchBudgetExpired, type ExactConfig } from '../../engine/exact/search.js';
import { register } from '../registry.js';
import { SearchParamsSchema, StrategistParamsSchema, type SearchParams, type StrategistParams } from '../schema.js';
import { planText, strategistDecide } from '../../llm/strategist.js';
import type { GamePlan } from '../interfaces.js';
import type { BehaviorImpl } from './opponent.js';
import type { EvalImpl } from './evaluator.js';
import { otherSide } from './battle.js';

export interface SearchTrace {
  choice: string;
  scores: Array<{ choice: string; score: number }>;
  note?: string;
  predictedSwitch?: boolean;
  answersPredictedSwitch?: boolean;
  /** Set when this search already chose the plan. buildBot keeps it. */
  gamePlan?: GamePlan | null;
  /** Clock the strategist actually used. */
  budgetMs?: number;
  /** Whether this turn called Grok, reused a plan, or skipped it. */
  grok?: string;
}

export interface SearchCtx {
  evaluate: EvalImpl;
  behavior: BehaviorImpl;
  plan: GamePlan | null;
  rng: PRNG;
  rating?: number;
  /** Live Thompson arm for this game, when the facility drew one. */
  variantId?: string;
  /** Wall-clock deadline. Search returns the ranking it has when this passes. */
  deadlineMs?: number;
  /** Decision cap for the strategist. The live clock can shrink `timeBudgetMs`. */
  budgetMs?: number;
}

export interface SearchImpl {
  id: string;
  params: SearchParams;
  search(battle: Battle, side: SideId, ctx: SearchCtx): Promise<SearchTrace>;
}

const ALGORITHMS = ['greedy-1ply', 'expectimax', 'depth-n', 'mcts-stub', 'random', 'max-damage', 'legacy', 'strategist'] as const;

export function registerSearch(): void {
  for (const id of ALGORITHMS) {
    if (id === 'strategist') {
      register<StrategistParams>({
        layer: 'search',
        id,
        schema: StrategistParamsSchema,
        defaults: StrategistParamsSchema.parse({}),
        create: params => ({
          id,
          params,
          search: (battle: Battle, side: SideId, ctx: SearchCtx) => strategistLine(params, battle, side, ctx),
        }),
      });
      continue;
    }
    register<SearchParams>({
      layer: 'search',
      id,
      schema: SearchParamsSchema,
      defaults: SearchParamsSchema.parse(id === 'expectimax' ? { opponentModel: 'uniform', depth: 1 } : {}),
      create: params => ({
        id,
        params,
        search: (battle: Battle, side: SideId, ctx: SearchCtx) => runSearch(id, params, battle, side, ctx),
      }),
    });
  }
}

async function runSearch(
  id: (typeof ALGORITHMS)[number],
  params: SearchParams,
  battle: Battle,
  side: SideId,
  ctx: SearchCtx
): Promise<SearchTrace> {
  const legal = legalChoices(battle, side);
  if (legal.length === 0) return { choice: 'default', scores: [] };
  if (id === 'random') {
    const choice = legal[ctx.rng.random(legal.length)] ?? legal[0];
    return { choice, scores: legal.map(item => ({ choice: item, score: item === choice ? 1 : 0 })) };
  }
  if (id === 'max-damage') {
    const choice = maxDamageChoice(battle, side, legal);
    return { choice, scores: [{ choice, score: 1 }] };
  }
  if (id === 'legacy') {
    const decision = await legacyDecide({ kind: 'legacy' }, battle, side, ctx.rng);
    return { choice: decision.choice, scores: decision.scores ?? [] };
  }
  if (id === 'mcts-stub') {
    const trace = exactSearch(battle, side, exactConfig(params, 'max-damage', 'hp', 1, ctx.deadlineMs));
    return { ...trace, note: 'mcts-stub delegates the rollout to exact 1-ply' };
  }
  if (useExact(id, params, ctx)) {
    const model = ctx.behavior.exactModel || params.opponentModel;
    const depth = id === 'greedy-1ply' ? params.depth : params.depth;
    return exactSearch(battle, side, exactConfig(params, model, ctx.evaluate.kind === 'full' ? 'full' : 'hp', depth, ctx.deadlineMs));
  }
  const trace = outlined(battle, side, params, ctx, params.depth);
  if (params.samples > 1) trace.note = `samples=${params.samples} recorded; this battle is one world`;
  return trace;
}

/**
 * Grok writes the plan on critical turns. Jev scores every turn against that plan.
 * The simulator replaces the proposal when its line leads by more than the margin.
 * A missing key or a timeout leaves the proposal to exact search, then the same veto.
 */
async function strategistLine(
  params: StrategistParams,
  battle: Battle,
  side: SideId,
  ctx: SearchCtx,
): Promise<SearchTrace> {
  const budgetMs = ctx.budgetMs ?? params.timeBudgetMs;
  const decided = await strategistDecide({ battle, side, params, budgetMs });
  const gamePlan: GamePlan | null = decided.plan
    ? {
        style: ctx.plan?.style ?? 'balanced',
        winCondition: decided.plan.winCondition || ctx.plan?.winCondition || 'the remaining win condition',
        preserve: decided.plan.preserve,
        notes: planText(decided.plan),
      }
    : ctx.plan;
  const note = [
    decided.veto ? 'veto' : decided.fallback ? 'search' : 'jev',
    `grok=${decided.grok}`,
    `budget_ms=${budgetMs}`,
    `decision_ms=${decided.latencyMs}`,
  ].join(' ');
  return {
    choice: decided.choice,
    scores: decided.scores,
    gamePlan,
    note,
    budgetMs,
    grok: decided.grok,
  };
}

function useExact(id: string, params: SearchParams, ctx: SearchCtx): boolean {
  if (ctx.evaluate.kind === 'weighted') return false;
  if (params.risk !== 'expected-value') return false;
  if (!ctx.behavior.exactModel && id !== 'greedy-1ply') return false;
  if (id === 'greedy-1ply' && ctx.behavior.exactModel === 'uniform') return true;
  return ctx.behavior.exactModel != null;
}

export function exactConfig(
  params: SearchParams,
  opponentModel: ExactConfig['opponentModel'],
  evalMode: 'hp' | 'full',
  depth: number,
  deadlineMs?: number,
): ExactConfig {
  return { depth, opponentModel, evalMode, errorAsLoss: false, samples: params.samples, deadlineMs };
}

function outlined(battle: Battle, side: SideId, params: SearchParams, ctx: SearchCtx, depth: number): SearchTrace {
  const legal = legalChoices(battle, side);
  if (legal.length === 0) return { choice: 'default', scores: [] };
  if (legal.length === 1) return { choice: legal[0], scores: [{ choice: legal[0], score: 0 }] };
  const snap = snapshot(battle);
  const scores: Array<{ choice: string; score: number }> = [];
  for (const choice of legal) {
    if (searchBudgetExpired(ctx.deadlineMs, scores.length)) break;
    scores.push({
      choice,
      score: scoreChoice(snap, side, choice, params, ctx, depth),
    });
  }
  scores.sort((a, b) => b.score - a.score || a.choice.localeCompare(b.choice));
  return { choice: scores[0].choice, scores };
}

function scoreChoice(
  snap: string,
  side: SideId,
  choice: string,
  params: SearchParams,
  ctx: SearchCtx,
  depth: number
): number {
  const opp = otherSide(side);
  const probe = cloneFromSnapshot(snap);
  const lines = ctx.behavior.lines(probe, opp, ctx.rating);
  if (lines.length === 0) return leaf(probe, side, choice, undefined, params, ctx, depth);
  const values: number[] = [];
  const weights: number[] = [];
  for (const line of lines) {
    if (searchBudgetExpired(ctx.deadlineMs, values.length)) break;
    values.push(leaf(cloneFromSnapshot(snap), side, choice, line.choice, params, ctx, depth));
    weights.push(line.weight);
  }
  return aggregate(values, weights, params.risk, params.variancePenalty);
}

function leaf(
  battle: Battle,
  side: SideId,
  choice: string,
  oppChoice: string | undefined,
  params: SearchParams,
  ctx: SearchCtx,
  depth: number
): number {
  const ok = playChoices(battle, side, choice, oppChoice);
  if (!ok || battle.ended || depth <= 1) return ctx.evaluate.score(battle, side, ctx.plan);
  return outlined(battle, side, params, ctx, depth - 1).scores[0]?.score ?? ctx.evaluate.score(battle, side, ctx.plan);
}

function aggregate(values: number[], weights: number[], risk: SearchParams['risk'], penalty: number): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const mean = values.reduce((sum, value, index) => sum + value * weights[index], 0) / total;
  if (risk === 'minimax') return Math.min(...values);
  if (risk === 'risk-averse') {
    const variance = values.reduce((sum, value, index) => sum + weights[index] * (value - mean) ** 2, 0) / total;
    return mean - penalty * Math.sqrt(variance);
  }
  return mean;
}
