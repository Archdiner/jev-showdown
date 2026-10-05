import { Battle } from '@pkmn/sim';
import { SideId, legalChoices, otherSide } from '../engine/exact/battle-utils.js';
import { EXACT_1PLY, exactSearch } from '../engine/exact/search.js';
import { readLog } from './context/log.js';
import { renderContextBrief } from './context-brief.js';
import { GatewayClient } from './gateway-client.js';
import { DEFAULT_REVIEWER_MODEL_ID } from './models.js';

export const STRATEGIST_TIMEOUT_MS = 20_000;

export interface GamePlan {
  winCondition: string;
  preserve: string[];
  sacks: string[];
  threats: string[];
  notes: string;
}

export interface StrategistDecision {
  choice: string;
  source: 'grok' | 'search';
  plan: GamePlan | null;
  confidence: number | null;
  reasoning: string;
  error?: string;
  latencyMs: number;
}

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'confidence', 'reasoning', 'plan'],
  properties: {
    action: { type: 'string' },
    confidence: { type: 'number' },
    reasoning: { type: 'string' },
    plan: {
      type: 'object',
      additionalProperties: false,
      required: ['winCondition', 'preserve', 'sacks', 'threats', 'notes'],
      properties: {
        winCondition: { type: 'string' },
        preserve: { type: 'array', items: { type: 'string' } },
        sacks: { type: 'array', items: { type: 'string' } },
        threats: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
      },
    },
  },
} as const;

const SYSTEM = [
  'You play gen 9 random battle singles.',
  'Choose any legal action: a move, a switch, or terastallize when that string is listed.',
  'Use the brief. Do not invent a type chart it does not state.',
  'Update the game plan: win condition, who to preserve, who can be sacked, and the threats.',
  'Return JSON only. The action must be copied from the legal list.',
].join(' ');

const plans = new WeakMap<Battle, Map<SideId, GamePlan>>();

/**
 * Grok 4.7 picks one legal action and updates the plan.
 * A missing key, timeout, bad JSON, or illegal action uses exact 1-ply search.
 */
export async function strategistDecide(args: {
  battle: Battle;
  side: SideId;
  client?: GatewayClient;
  timeoutMs?: number;
}): Promise<StrategistDecision> {
  const started = Date.now();
  const legal = strategistChoices(args.battle, args.side);
  const fallbackChoice = searchChoice(args.battle, args.side, legal);
  if (legal.length === 0) {
    return done(fallbackChoice, 'search', null, null, '', Date.now() - started);
  }

  const timeoutMs = args.timeoutMs ?? STRATEGIST_TIMEOUT_MS;
  const client = args.client ?? new GatewayClient({
    timeoutMs,
    perTurnLatencyBudgetMs: timeoutMs,
    maxRetries: 0,
    log: () => {},
  });
  const plan = currentPlan(args.battle, args.side);
  const brief = renderContextBrief(args.battle, args.side);
  const recent = readLog(args.battle.log as string[], otherSide(args.side)).recent.slice(-8);
  client.startTurn();
  const result = await client.chat({
    model: DEFAULT_REVIEWER_MODEL_ID,
    temperature: 0,
    maxTokens: 500,
    jsonSchema: PLAN_SCHEMA as unknown as Record<string, unknown>,
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          brief.text,
          'RECENT',
          recent.join('\n') || 'none',
          plan ? `CURRENT PLAN ${plan.winCondition}` : 'CURRENT PLAN none',
          'LEGAL',
          ...legal.map(choice => `- ${choice}`),
          'Return one legal action.',
        ].join('\n'),
      },
    ],
  });
  client.endTurn();
  const latencyMs = Date.now() - started;
  if (!result.ok) return done(fallbackChoice, 'search', plan, null, '', latencyMs, result.error);

  const parsed = parseStrategist(result.data, legal);
  if (!parsed) return done(fallbackChoice, 'search', plan, null, '', latencyMs, 'unusable_plan');
  remember(args.battle, args.side, parsed.plan);
  return done(parsed.action, 'grok', parsed.plan, parsed.confidence, parsed.reasoning, latencyMs);
}

/** Moves, switches, and Terastallize when the request allows it. */
export function strategistChoices(battle: Battle, side: SideId): string[] {
  const base = legalChoices(battle, side);
  const request = battle.getSide(side).activeRequest as { active?: Array<{ canTerastallize?: unknown }> } | null;
  if (!request?.active?.[0]?.canTerastallize) return base;
  const tera = base.filter(choice => choice.startsWith('move ')).map(choice => `${choice} terastallize`);
  return [...base, ...tera];
}

export function parseStrategist(raw: string, legal: string[]): { action: string; confidence: number; reasoning: string; plan: GamePlan } | null {
  try {
    const data = JSON.parse(raw) as { action?: unknown; confidence?: unknown; reasoning?: unknown; plan?: GamePlan };
    const action = typeof data.action === 'string' ? data.action.trim() : '';
    if (!legal.includes(action)) return null;
    const plan = data.plan ?? { winCondition: '', preserve: [], sacks: [], threats: [], notes: '' };
    return {
      action,
      confidence: clamp01(Number(data.confidence)),
      reasoning: String(data.reasoning ?? '').slice(0, 600),
      plan: {
        winCondition: String(plan.winCondition ?? '').slice(0, 240),
        preserve: asList(plan.preserve),
        sacks: asList(plan.sacks),
        threats: asList(plan.threats),
        notes: String(plan.notes ?? '').slice(0, 240),
      },
    };
  } catch {
    return null;
  }
}

function searchChoice(battle: Battle, side: SideId, legal: string[]): string {
  try {
    const choice = exactSearch(battle, side, EXACT_1PLY).choice;
    if (legal.length === 0 || legal.includes(choice)) return choice;
  } catch {
    // the request can be a preview or a forced switch the search does not score
  }
  return legal.find(choice => !choice.includes('terastallize')) ?? legal[0] ?? 'default';
}

function currentPlan(battle: Battle, side: SideId): GamePlan | null {
  return plans.get(battle)?.get(side) ?? null;
}

function remember(battle: Battle, side: SideId, plan: GamePlan): void {
  let bySide = plans.get(battle);
  if (!bySide) {
    bySide = new Map();
    plans.set(battle, bySide);
  }
  bySide.set(side, plan);
}

function done(
  choice: string,
  source: 'grok' | 'search',
  plan: GamePlan | null,
  confidence: number | null,
  reasoning: string,
  latencyMs: number,
  error?: string
): StrategistDecision {
  return { choice, source, plan, confidence, reasoning, latencyMs, error };
}

function asList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item)).slice(0, 6);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
