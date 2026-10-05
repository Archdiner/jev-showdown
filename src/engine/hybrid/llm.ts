import type { Battle } from '@pkmn/sim';
import type { GatewayClient } from '../../llm/gateway-client.js';
import type { FoeMon } from '../../client/decision-battle.js';
import type { HybridParams } from '../../config/schema.js';
import type { SideId } from '../exact/battle-utils.js';
import type { WorldSample } from './worlds.js';
import type { OpponentStyle } from './worlds.js';

export const HYBRID_MODEL = 'alibaba/qwen3.8-27b';
export const HYBRID_PLANNER = 'anthropic/claude-opus-5.5';

const CEREBRAS = { gateway: { order: ['cerebras'], only: ['cerebras'] } };

export interface HybridPlan {
  winCondition: string;
  preserve: string[];
  tera: 'hold' | 'now' | 'soon';
  threats: string[];
  style: OpponentStyle;
  notes: string;
}

export interface HybridLedger {
  plan: HybridPlan | null;
  inflight: Promise<void> | null;
  costUsd: number;
  timeouts: number;
  faintCount: number;
  revealCount: number;
  lastPlanTurn: number;
}

export function emptyLedger(): HybridLedger {
  return {
    plan: null,
    inflight: null,
    costUsd: 0,
    timeouts: 0,
    faintCount: -1,
    revealCount: -1,
    lastPlanTurn: -999,
  };
}

export function maybeStartPlan(
  ledger: HybridLedger,
  battle: Battle,
  side: SideId,
  foes: FoeMon[],
  worlds: WorldSample[],
  params: HybridParams,
  client: GatewayClient | null,
  allowed: boolean,
): void {
  if (!params.plan || !allowed || !client) return;
  if (ledger.inflight) return;
  const faints = battle.getSide(side).pokemon.filter(mon => mon.fainted).length;
  const reveals = foes.reduce((sum, mon) => sum + (mon.moves?.length || 0) + (mon.ability ? 1 : 0) + (mon.item ? 1 : 0), 0);
  const turn = battle.turn || 0;
  const due = ledger.plan == null
    || turn <= 1
    || faints !== ledger.faintCount
    || reveals !== ledger.revealCount
    || turn - ledger.lastPlanTurn >= params.planEvery;
  if (!due) return;
  ledger.faintCount = faints;
  ledger.revealCount = reveals;
  ledger.lastPlanTurn = turn;
  const our = battle.getSide(side).pokemon.map(mon => mon.species.name);
  const brief = planBrief(battle, side, foes, worlds);
  ledger.inflight = requestPlan(client, params, brief, our).then(result => {
    ledger.inflight = null;
    if (result.timeout) ledger.timeouts += 1;
    ledger.costUsd += result.costUsd;
    if (result.plan) ledger.plan = result.plan;
  }).catch(() => {
    ledger.inflight = null;
    ledger.timeouts += 1;
  });
}

export async function judgeMove(
  client: GatewayClient,
  params: HybridParams,
  plan: HybridPlan | null,
  rows: Array<{ choice: string; score: number; koRate: number }>,
  budgetMs: number,
): Promise<{ choice: string | null; costUsd: number; timeout: boolean }> {
  const ranked = [...rows].sort((a, b) => b.score - a.score).slice(0, 3);
  if (ranked.length < 2) return { choice: ranked[0]?.choice ?? null, costUsd: 0, timeout: false };
  const margin = params.margin;
  if (ranked[0].score - ranked[1].score > margin) {
    return { choice: null, costUsd: 0, timeout: false };
  }
  const offered = ranked.map(row => row.choice);
  const prompt = [
    'Pick one of the offered choices. You may override the search only because these scores are close.',
    'Do not switch away from a clearly better line. Return JSON: {"choice":"<one offered string>"}',
    plan ? `Plan: win ${plan.winCondition}; preserve ${plan.preserve.join(', ') || 'none'}; tera ${plan.tera}; threats ${plan.threats.join(', ') || 'none'}; style ${plan.style}. ${plan.notes}` : 'No plan yet.',
    'Choices:',
    ...ranked.map(row => `${row.choice} score=${row.score.toFixed(3)} ko=${row.koRate.toFixed(2)}`),
  ].join('\n');
  const result = await complete(client, params.model, 'medium', prompt, budgetMs, true);
  if (!result.ok) return { choice: null, costUsd: result.costUsd, timeout: result.timeout };
  const choice = readChoice(result.text, offered);
  if (!choice) return { choice: null, costUsd: result.costUsd, timeout: false };
  const picked = ranked.find(row => row.choice === choice);
  if (!picked || ranked[0].score - picked.score > margin) {
    return { choice: null, costUsd: result.costUsd, timeout: false };
  }
  return { choice, costUsd: result.costUsd, timeout: false };
}

function planBrief(battle: Battle, side: SideId, foes: FoeMon[], worlds: WorldSample[]): string {
  const me = battle.getSide(side);
  const ours = me.pokemon.map(mon => {
    const moves = mon.moveSlots.map(slot => slot.move).filter(Boolean).join('/');
    const hp = mon.maxhp > 0 ? Math.round(100 * mon.hp / mon.maxhp) : 0;
    return `${mon.species.name} L${mon.level} ${hp}% ${mon.ability || ''} ${mon.item || ''} [${moves}]${mon.terastallized ? ` tera:${mon.terastallized}` : ''}`;
  });
  const foeLines = foes.map(mon => {
    const hp = mon.maxhp > 0 ? Math.round(100 * mon.hp / mon.maxhp) : 0;
    return `${mon.species} ${hp}% moves=${(mon.moves || []).join('/') || 'unknown'} ability=${mon.ability || '?'} item=${mon.item || '?'}${mon.hazardChip ? ' hazard-chip' : ''}${mon.statusMove ? ' status-move' : ''}${mon.speed ? ` speed=${mon.speed}` : ''}`;
  });
  const candidates = worlds.slice(0, 6).map(world => `${(world.weight * 100).toFixed(1)}% ${world.tag}`);
  const weather = (battle.field as { weather?: string }).weather || 'none';
  return [
    `Turn ${battle.turn}. Weather ${weather}.`,
    'Our sets:',
    ...ours,
    'Opponent reveals:',
    ...(foeLines.length ? foeLines : ['none yet']),
    'Candidate worlds:',
    ...(candidates.length ? candidates : ['none']),
  ].join('\n');
}

async function requestPlan(
  client: GatewayClient,
  params: HybridParams,
  brief: string,
  ourSpecies: string[],
): Promise<{ plan: HybridPlan | null; costUsd: number; timeout: boolean }> {
  const prompt = [
    'Write a game plan from public information. Return JSON only:',
    '{"winCondition":"<one of our species>","preserve":["<our species>"],"tera":"hold|now|soon","threats":["<opponent species>"],"style":"aggressive|stall|balanced","notes":"one sentence"}',
    'winCondition and preserve must be species on our team. style describes the opponent.',
    `Our species: ${ourSpecies.join(', ')}`,
    brief,
  ].join('\n');
  const model = params.plannerModel || HYBRID_PLANNER;
  const effort = model === params.model ? 'medium' : 'low';
  const cerebras = model === HYBRID_MODEL;
  const result = await complete(client, model, effort, prompt, 6000, cerebras);
  if (!result.ok) return { plan: null, costUsd: result.costUsd, timeout: result.timeout };
  return { plan: parsePlan(result.text, ourSpecies), costUsd: result.costUsd, timeout: false };
}

async function complete(
  client: GatewayClient,
  model: string,
  effort: 'low' | 'medium',
  prompt: string,
  budgetMs: number,
  cerebras: boolean,
): Promise<{ ok: boolean; text: string; costUsd: number; timeout: boolean }> {
  if (budgetMs < 400) return { ok: false, text: '', costUsd: 0, timeout: true };
  const result = await client.chat({
    model,
    messages: [
      { role: 'system', content: 'You are a singles random-battle planner. Reply with JSON only.' },
      { role: 'user', content: prompt },
    ],
    maxTokens: model === HYBRID_MODEL ? 10000 : Math.min(4000, 10000),
    reasoningEffort: effort,
    omitTemperature: true,
    ...(cerebras ? { providerOptions: CEREBRAS } : {}),
  });
  if (!result.ok) {
    const timeout = /timeout|aborted|latency_budget/i.test(result.error);
    return { ok: false, text: '', costUsd: result.metrics.costUsd, timeout };
  }
  return { ok: true, text: result.data, costUsd: result.metrics.costUsd, timeout: false };
}

function parsePlan(text: string, ourSpecies: string[]): HybridPlan | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const ours = new Map(ourSpecies.map(name => [name.toLowerCase().replace(/[^a-z0-9]+/g, ''), name]));
  const win = ours.get(String(raw.winCondition || '').toLowerCase().replace(/[^a-z0-9]+/g, '')) || ourSpecies[0] || '';
  const preserve = Array.isArray(raw.preserve)
    ? raw.preserve.map(name => ours.get(String(name).toLowerCase().replace(/[^a-z0-9]+/g, ''))).filter((name): name is string => !!name)
    : [];
  const tera = raw.tera === 'now' || raw.tera === 'soon' || raw.tera === 'hold' ? raw.tera : 'hold';
  const style = raw.style === 'aggressive' || raw.style === 'stall' ? raw.style : 'balanced';
  const threats = Array.isArray(raw.threats) ? raw.threats.map(name => String(name)).filter(Boolean).slice(0, 6) : [];
  const notes = typeof raw.notes === 'string' ? raw.notes.slice(0, 280) : '';
  if (!win) return null;
  return { winCondition: win, preserve, tera, threats, style, notes };
}

function readChoice(text: string, offered: string[]): string | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return offered.find(choice => text.includes(choice)) ?? null;
  }
  try {
    const raw = JSON.parse(match[0]) as { choice?: string };
    if (raw.choice && offered.includes(raw.choice)) return raw.choice;
  } catch {
    return offered.find(choice => text.includes(choice)) ?? null;
  }
  return null;
}

export function planBonus(battle: Battle, side: SideId, plan: HybridPlan | null): number {
  if (!plan) return 0;
  const me = battle.getSide(side);
  const foe = me.foe;
  let bonus = 0;
  const names = [plan.winCondition, ...plan.preserve];
  for (const name of names) {
    const mon = me.pokemon.find(candidate => candidate.species.name.toLowerCase() === name.toLowerCase());
    if (!mon || mon.maxhp <= 0) continue;
    bonus += 0.35 * Math.max(0, mon.hp) / mon.maxhp;
  }
  for (const name of plan.threats) {
    const mon = foe.pokemon.find(candidate => candidate.species.name.toLowerCase() === name.toLowerCase());
    if (mon && (mon.fainted || mon.hp <= 0)) bonus += 0.45;
  }
  return bonus;
}
