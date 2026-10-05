import { Battle } from '@pkmn/sim';
import { SideId, legalChoices } from '../engine/exact/battle-utils.js';
import { EXACT_1PLY, exactSearch } from '../engine/exact/search.js';
import { renderContextBrief } from './context-brief.js';
import { GatewayClient } from './gateway-client.js';
import type { EvaluateQuestion } from './gateway-client.js';
import { JEV_MODEL_ID } from './models.js';

export const JEV_TIMEOUT_MS = 2_500;

const LEVELS = ['terrible', 'poor', 'even', 'good', 'best'];
const RISKS = ['safe', 'mild', 'real', 'severe', 'losing'];

export interface JevTurnScore {
  choice: string | null;
  source: 'jev' | 'search';
  matchup: number | null;
  switchProbability: number | null;
  values: Record<string, number>;
  risks: Record<string, number>;
  degraded: boolean;
  error?: string;
  latencyMs: number;
  costUsd: number;
}

/**
 * Jev scores the situation brief: matchup, opponent switch, and value/risk
 * for each legal action (moves, switches, and Terastallize). The pick is
 * value minus a quarter of the risk. Any failure leaves the pick empty so
 * the caller can use search.
 */
export async function scoreWithJev(args: {
  battle: Battle;
  side: SideId;
  client?: GatewayClient;
  timeoutMs?: number;
}): Promise<JevTurnScore> {
  const started = Date.now();
  const legal = jevChoices(args.battle, args.side).slice(0, 8);
  const timeoutMs = args.timeoutMs ?? JEV_TIMEOUT_MS;
  const client = args.client ?? new GatewayClient({
    timeoutMs,
    perTurnLatencyBudgetMs: timeoutMs,
    maxRetries: 0,
    log: () => {},
  });
  if (legal.length === 0) return empty('no_choices', Date.now() - started);

  const questions: Record<string, EvaluateQuestion> = {
    matchup: {
      type: 'score',
      instructions: 'How favored is our active matchup, using only the brief?',
      criteria: LEVELS,
    },
    opponentWillSwitch: {
      type: 'boolean',
      instructions: 'Will the opponent switch to a different Pokemon this turn?',
      criteria: { true: 'they switch', false: 'they stay' },
    },
  };
  legal.forEach((choice, index) => {
    const id = `c${index}`;
    questions[`value_${id}`] = {
      type: 'score',
      instructions: `Value of ${choice}. Switches, status, setup, and protect can be valuable even with no damage.`,
      criteria: LEVELS,
    };
    questions[`risk_${id}`] = {
      type: 'score',
      instructions: `Risk of ${choice}. Higher means we are more likely to lose a Pokemon or the win condition.`,
      criteria: RISKS,
    };
  });

  client.startTurn();
  const result = await client.evaluate({
    model: JEV_MODEL_ID,
    state: renderContextBrief(args.battle, args.side).text,
    questions,
  });
  client.endTurn();
  const latencyMs = Date.now() - started;
  if (!result.ok) return empty(result.error, latencyMs, result.metrics.costUsd);

  const values: Record<string, number> = {};
  const risks: Record<string, number> = {};
  const answers = result.data.answers;
  legal.forEach((choice, index) => {
    const id = `c${index}`;
    const value = answers[`value_${id}`]?.score;
    const risk = answers[`risk_${id}`]?.score;
    if (typeof value === 'number') values[choice] = clamp01(value / (LEVELS.length - 1));
    if (typeof risk === 'number') risks[choice] = clamp01(risk / (RISKS.length - 1));
  });
  const matchup = answers.matchup?.score;
  const switchP = answers.opponentWillSwitch?.probability;
  if (Object.keys(values).length === 0) return empty('unusable_answers', latencyMs, result.metrics.costUsd);
  return {
    choice: bestChoice(values, risks),
    source: 'jev',
    matchup: typeof matchup === 'number' ? clamp01(matchup / (LEVELS.length - 1)) : null,
    switchProbability: typeof switchP === 'number' ? clamp01(switchP) : null,
    values,
    risks,
    degraded: false,
    latencyMs,
    costUsd: result.metrics.costUsd,
  };
}

/** Jev's pick when the call works. Exact 1-ply search otherwise. */
export async function jevDecide(args: {
  battle: Battle;
  side: SideId;
  client?: GatewayClient;
  timeoutMs?: number;
}): Promise<JevTurnScore> {
  const scored = await scoreWithJev(args);
  if (scored.choice) return scored;
  const legal = jevChoices(args.battle, args.side);
  let choice = legal[0] ?? 'default';
  try {
    const searched = exactSearch(args.battle, args.side, EXACT_1PLY).choice;
    if (legal.length === 0 || legal.includes(searched)) choice = searched;
  } catch {
    // preview and some forced switches are not scored by search
  }
  return { ...scored, choice, source: 'search' };
}

export function jevChoices(battle: Battle, side: SideId): string[] {
  const base = legalChoices(battle, side);
  const request = battle.getSide(side).activeRequest as { active?: Array<{ canTerastallize?: unknown }> } | null;
  if (!request?.active?.[0]?.canTerastallize) return base;
  return [...base, ...base.filter(choice => choice.startsWith('move ')).map(choice => `${choice} terastallize`)];
}

function bestChoice(values: Record<string, number>, risks: Record<string, number>): string | null {
  let best: string | null = null;
  let bestNet = -Infinity;
  for (const [choice, value] of Object.entries(values)) {
    const net = value - 0.25 * (risks[choice] ?? 0);
    if (net > bestNet) {
      bestNet = net;
      best = choice;
    }
  }
  return best;
}

function empty(error: string, latencyMs: number, costUsd = 0): JevTurnScore {
  return {
    choice: null,
    source: 'search',
    matchup: null,
    switchProbability: null,
    values: {},
    risks: {},
    degraded: true,
    error,
    latencyMs,
    costUsd,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
