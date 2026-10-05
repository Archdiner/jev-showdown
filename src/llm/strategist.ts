import { Battle } from '@pkmn/sim';
import { StrategistParamsSchema, type StrategistParams } from '../config/schema.js';
import { SideId, legalChoices } from '../engine/exact/battle-utils.js';
import { EXACT_1PLY, exactSearch } from '../engine/exact/search.js';
import { activeKey, criticalReasons, readBoard, type BoardSnap } from './critical-turn.js';
import { renderContextBrief } from './context-brief.js';
import { GatewayClient } from './gateway-client.js';
import { scoreWithJev } from './jev-turn.js';
import { DEFAULT_REVIEWER_MODEL_ID } from './models.js';
import { verifyChoices, vetoChoice } from './sim-veto.js';
import { noteSwitchChoice, penalizeSwitchScores, switchHistoryText, switchState } from './switch-streak.js';
import { recordStrategistTurn } from './turn-meter.js';

/** Plan-call cap. Grok 4.7 at effort `none` on a compact plan is about 5–9s; the old 20s default ran out of reasoning tokens. */
export const STRATEGIST_TIMEOUT_MS = 11_000;

export interface GamePlan {
  winCondition: string;
  preserve: string[];
  sacks: string[];
  threats: string[];
  notes: string;
}

export type GrokStatus = 'called' | 'cached' | 'timeout' | 'skipped' | 'error';

export interface StrategistDecision {
  choice: string;
  source: 'jev' | 'search' | 'veto';
  plan: GamePlan | null;
  grok: GrokStatus;
  critical: boolean;
  reasons: string[];
  confidence: number | null;
  reasoning: string;
  error?: string;
  latencyMs: number;
  grokLatencyMs: number;
  budgetMs: number;
  costUsd: number;
  veto: boolean;
  fallback: boolean;
  scores: Array<{ choice: string; score: number }>;
}

interface CacheEntry {
  plan: GamePlan | null;
  snap: BoardSnap | null;
  failures: number;
  generation: number;
}

interface GrokResult {
  ok: boolean;
  plan: GamePlan | null;
  error?: string;
  latencyMs: number;
  costUsd: number;
  promptTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['win', 'keep', 'sack', 'threat', 'note'],
  properties: {
    win: { type: 'string' },
    keep: { type: 'array', items: { type: 'string' } },
    sack: { type: 'array', items: { type: 'string' } },
    threat: { type: 'string' },
    note: { type: 'string' },
  },
} as const;

const SYSTEM = 'Gen 9 random battles. Update the plan as JSON with win, keep, sack, threat, and note. Short strings. Do not choose a move.';

const cache = new WeakMap<Battle, Map<SideId, CacheEntry>>();

const DEFAULTS = StrategistParamsSchema.parse({});

/**
 * Critical turns ask Grok 4.7 for a plan. Every turn Jev scores legal actions
 * against that plan, then the simulator veto can replace the proposal.
 * A missing key, a timeout, or an empty Jev answer uses exact 1-ply, then the same veto.
 */
export async function strategistDecide(args: {
  battle: Battle;
  side: SideId;
  client?: GatewayClient;
  timeoutMs?: number;
  budgetMs?: number;
  params?: Partial<StrategistParams>;
}): Promise<StrategistDecision> {
  const started = Date.now();
  const params = StrategistParamsSchema.parse({
    ...DEFAULTS,
    ...(args.params ?? {}),
    ...(args.timeoutMs != null ? { grokTimeoutMs: args.timeoutMs } : {}),
  });
  const budget = args.budgetMs ?? params.timeBudgetMs;
  const legal = strategistChoices(args.battle, args.side);
  const entry = loadCache(args.battle, args.side);
  const board = readBoard(args.battle, args.side);
  const switches = switchState(args.battle, args.side);
  const reasons = params.planMode === 'always'
    ? ['always']
    : criticalReasons(entry.snap, board, params);
  const retryOpen = !entry.plan && entry.failures < 2 && reasons.length === 0;
  if (retryOpen) reasons.push('retry');
  const critical = reasons.length > 0;

  if (legal.length === 0) {
    return finish({
      started,
      budget,
      choice: 'default',
      source: 'search',
      plan: entry.plan,
      grok: 'skipped',
      critical,
      reasons,
      error: 'no_choices',
      grokLatencyMs: 0,
      costUsd: 0,
      veto: false,
      fallback: true,
      scores: [],
      promptTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      jev: false,
    });
  }

  const slice = Math.min(params.grokTimeoutMs, Math.max(0, budget - Math.min(params.jevReserveMs, budget)));
  let plan = entry.plan;
  let grok: GrokStatus = plan ? 'cached' : 'skipped';
  let grokError: string | undefined;
  let grokLatencyMs = 0;
  let costUsd = 0;
  let promptTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  const grokStarted = Date.now();
  let pending: Promise<GrokResult> | null = null;
  let generation = entry.generation;
  const key = activeKey(board);
  if (critical && slice > 0 && slice >= Math.min(400, params.grokTimeoutMs)) {
    generation = entry.generation + 1;
    entry.generation = generation;
    pending = requestPlan(args, params, board, reasons, switches, plan);
  }

  const sim = verifyChoices(args.battle, args.side);
  const penalized = penalizeSwitchScores(sim, switches.streak, switches.progress, params.switchCost);

  if (pending) {
    const waited = await waitFor(pending, Math.max(0, slice - (Date.now() - grokStarted)));
    if (waited.status === 'ok') {
      grokLatencyMs = waited.value.latencyMs;
      costUsd += waited.value.costUsd;
      promptTokens += waited.value.promptTokens;
      outputTokens += waited.value.outputTokens;
      reasoningTokens += waited.value.reasoningTokens;
      if (waited.value.ok && waited.value.plan) {
        plan = waited.value.plan;
        entry.plan = plan;
        entry.failures = 0;
        grok = 'called';
      } else {
        entry.failures += 1;
        grok = waited.value.error === 'timeout' ? 'timeout' : 'error';
        grokError = waited.value.error;
      }
    } else {
      grok = 'timeout';
      grokError = 'timeout';
      grokLatencyMs = Date.now() - started;
      entry.failures += 1;
      void pending.then(late => {
        if (!late.ok || !late.plan) return;
        const current = loadCache(args.battle, args.side);
        if (current.generation !== generation) return;
        if (activeKey(readBoard(args.battle, args.side)) !== key) return;
        current.plan = late.plan;
        current.failures = 0;
        recordStrategistTurn({
          grok: false,
          grokTimeout: false,
          jev: false,
          veto: false,
          fallback: false,
          costUsd: late.costUsd,
          promptTokens: late.promptTokens,
          outputTokens: late.outputTokens,
          reasoningTokens: late.reasoningTokens,
          grokMs: 0,
          decisionMs: 0,
          plan: null,
          countTurn: false,
        });
      });
    }
  }

  const remaining = Math.max(0, budget - (Date.now() - started));
  const jev = remaining < 200
    ? null
    : await scoreWithJev({
      battle: args.battle,
      side: args.side,
      client: args.client,
      timeoutMs: Math.min(2500, remaining),
      planText: planText(plan),
      switchNote: switchHistoryText(switches),
      switchStreak: switches.streak,
      switchProgress: switches.progress,
    });
  if (jev) costUsd += jev.costUsd;

  const search = searchChoice(args.battle, args.side, legal);
  const proposal = jev?.choice && legal.includes(jev.choice) ? jev.choice : search;
  const fallback = !jev?.choice;
  const decided = vetoChoice({
    proposal,
    scores: penalized,
    margin: params.vetoMargin,
    legal: penalized.map(row => row.choice),
  });
  const choice = legal.includes(decided.choice) ? decided.choice : search;
  noteSwitchChoice(args.battle, args.side, choice);
  entry.snap = board;
  saveCache(args.battle, args.side, entry);

  const scores = penalized.map(row => ({
    choice: row.choice,
    score: row.choice === choice ? row.score + 1000 : row.score,
  }));
  if (!scores.some(row => row.choice === choice)) scores.push({ choice, score: 1000 });

  return finish({
    started,
    budget,
    choice,
    source: decided.veto ? 'veto' : fallback ? 'search' : 'jev',
    plan,
    grok,
    critical,
    reasons,
    error: grokError ?? jev?.error,
    grokLatencyMs,
    costUsd,
    veto: Boolean(decided.veto),
    fallback,
    scores,
    promptTokens,
    outputTokens,
    reasoningTokens,
    jev: Boolean(jev && !jev.degraded),
  });
}

/** Moves, switches, and Terastallize when the request allows it. */
export function strategistChoices(battle: Battle, side: SideId): string[] {
  const base = legalChoices(battle, side);
  const request = battle.getSide(side).activeRequest as { active?: Array<{ canTerastallize?: unknown }> } | null;
  if (!request?.active?.[0]?.canTerastallize) return base;
  const tera = base.filter(choice => choice.startsWith('move ')).map(choice => `${choice} terastallize`);
  return [...base, ...tera];
}

export function parsePlan(raw: string): GamePlan | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const nested = data.plan && typeof data.plan === 'object' ? data.plan as Record<string, unknown> : null;
    const win = firstString(data.win, data.winCondition, nested?.winCondition, nested?.win);
    if (!win && !firstString(data.note, data.notes, nested?.notes)) return null;
    const keep = firstList(data.keep, data.preserve, nested?.preserve);
    const sack = firstList(data.sack, data.sacks, nested?.sacks);
    const threat = firstString(data.threat, nested?.threat);
    const threats = threat ? [threat] : firstList(data.threats, nested?.threats);
    return {
      winCondition: (win || 'the remaining win condition').slice(0, 80),
      preserve: keep,
      sacks: sack,
      threats,
      notes: firstString(data.note, data.notes, nested?.notes).slice(0, 80),
    };
  } catch {
    return null;
  }
}

/** @deprecated Plans no longer carry an action. Kept so older JSON still parses. */
export function parseStrategist(raw: string, legal: string[]): { action: string; confidence: number; reasoning: string; plan: GamePlan } | null {
  try {
    const data = JSON.parse(raw) as { action?: unknown; confidence?: unknown; reasoning?: unknown };
    const action = typeof data.action === 'string' ? data.action.trim() : '';
    const plan = parsePlan(raw);
    if (!plan || !legal.includes(action)) return null;
    return {
      action,
      confidence: clamp01(Number(data.confidence)),
      reasoning: String(data.reasoning ?? '').slice(0, 200),
      plan,
    };
  } catch {
    return null;
  }
}

export function planText(plan: GamePlan | null): string {
  if (!plan) return 'PLAN none';
  const keep = plan.preserve.length ? plan.preserve.join(', ') : 'none';
  const sack = plan.sacks.length ? plan.sacks.join(', ') : 'none';
  const threat = plan.threats.length ? plan.threats.join(', ') : 'none';
  return `PLAN win ${plan.winCondition}; keep ${keep}; sack ${sack}; threat ${threat}; ${plan.notes}`;
}

function requestPlan(
  args: { battle: Battle; side: SideId; client?: GatewayClient },
  params: StrategistParams,
  board: BoardSnap,
  reasons: string[],
  switches: { streak: number; progress: boolean; recent: string[] },
  plan: GamePlan | null,
): Promise<GrokResult> {
  const client = args.client ?? new GatewayClient({
    timeoutMs: params.grokTimeoutMs,
    perTurnLatencyBudgetMs: params.grokTimeoutMs,
    maxRetries: 0,
    log: line => console.log(line),
  });
  const brief = renderContextBrief(args.battle, args.side, params.planTokens);
  client.startTurn();
  return client.chat({
    model: DEFAULT_REVIEWER_MODEL_ID,
    temperature: 0,
    maxTokens: 120,
    reasoningEffort: params.reasoningEffort,
    jsonSchema: PLAN_SCHEMA as unknown as Record<string, unknown>,
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          brief.text,
          `event: ${reasons.join(',') || 'none'}`,
          planText(plan),
          switchHistoryText(switches),
          `turn ${board.turn} alive ${board.ourAlive}-${board.foeAlive}`,
        ].join('\n'),
      },
    ],
  }).then(result => {
    client.endTurn();
    const parsed = result.ok ? parsePlan(result.data) : null;
    return {
      ok: Boolean(result.ok && parsed),
      plan: parsed,
      error: result.ok ? (parsed ? undefined : 'unusable_plan') : result.error,
      latencyMs: result.metrics.latencyMs,
      costUsd: result.metrics.costUsd,
      promptTokens: result.metrics.tokensInput,
      outputTokens: result.metrics.tokensOutput,
      reasoningTokens: result.metrics.reasoningTokens,
    };
  }).catch(error => {
    client.endTurn();
    return {
      ok: false,
      plan: null,
      error: error instanceof Error ? error.message : 'plan_failed',
      latencyMs: 0,
      costUsd: 0,
      promptTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    };
  });
}

function finish(args: {
  started: number;
  budget: number;
  choice: string;
  source: StrategistDecision['source'];
  plan: GamePlan | null;
  grok: GrokStatus;
  critical: boolean;
  reasons: string[];
  error?: string;
  grokLatencyMs: number;
  costUsd: number;
  veto: boolean;
  fallback: boolean;
  scores: Array<{ choice: string; score: number }>;
  promptTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  jev: boolean;
}): StrategistDecision {
  const latencyMs = Date.now() - args.started;
  recordStrategistTurn({
    grok: args.grok === 'called',
    grokTimeout: args.grok === 'timeout',
    grokError: args.grok === 'error',
    jev: args.jev,
    veto: args.veto,
    fallback: args.fallback,
    costUsd: args.costUsd,
    promptTokens: args.promptTokens,
    outputTokens: args.outputTokens,
    reasoningTokens: args.reasoningTokens,
    grokMs: args.grok === 'called' || args.grok === 'timeout' ? args.grokLatencyMs : 0,
    decisionMs: latencyMs,
    plan: args.plan?.winCondition ?? null,
    countTurn: true,
  });
  console.log(
    `[strategist] budget_ms=${args.budget} decision_ms=${latencyMs} grok=${args.grok} ` +
    `grok_ms=${args.grokLatencyMs} tokens_in=${args.promptTokens} tokens_out=${args.outputTokens} ` +
    `reasoning_tokens=${args.reasoningTokens} critical=${args.reasons.join(',') || 'no'} ` +
    `veto=${args.veto ? 'yes' : 'no'} fallback=${args.fallback ? 'yes' : 'no'}`,
  );
  return {
    choice: args.choice,
    source: args.source,
    plan: args.plan,
    grok: args.grok,
    critical: args.critical,
    reasons: args.reasons,
    confidence: null,
    reasoning: args.reasons.join(','),
    error: args.error,
    latencyMs,
    grokLatencyMs: args.grokLatencyMs,
    budgetMs: args.budget,
    costUsd: args.costUsd,
    veto: args.veto,
    fallback: args.fallback,
    scores: args.scores,
  };
}

function waitFor<T>(promise: Promise<T>, ms: number): Promise<{ status: 'ok'; value: T } | { status: 'timeout' }> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ status: 'timeout' }), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve({ status: 'ok', value });
      },
      () => {
        clearTimeout(timer);
        resolve({ status: 'timeout' });
      },
    );
  });
}

function searchChoice(battle: Battle, side: SideId, legal: string[]): string {
  try {
    const choice = exactSearch(battle, side, EXACT_1PLY).choice;
    if (legal.length === 0 || legal.includes(choice)) return choice;
  } catch {
    // preview and some forced switches are not scored by search
  }
  return legal.find(choice => !choice.includes('terastallize')) ?? legal[0] ?? 'default';
}

function loadCache(battle: Battle, side: SideId): CacheEntry {
  let bySide = cache.get(battle);
  if (!bySide) {
    bySide = new Map();
    cache.set(battle, bySide);
  }
  const existing = bySide.get(side);
  if (existing) return existing;
  const created: CacheEntry = { plan: null, snap: null, failures: 0, generation: 0 };
  bySide.set(side, created);
  return created;
}

function saveCache(battle: Battle, side: SideId, entry: CacheEntry): void {
  let bySide = cache.get(battle);
  if (!bySide) {
    bySide = new Map();
    cache.set(battle, bySide);
  }
  bySide.set(side, entry);
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function firstList(...values: unknown[]): string[] {
  for (const value of values) {
    if (Array.isArray(value)) return value.map(item => String(item).slice(0, 40)).filter(Boolean).slice(0, 4);
  }
  return [];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
