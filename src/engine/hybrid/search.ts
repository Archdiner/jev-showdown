import { Battle, Dex, PRNG } from '@pkmn/sim';
import { GatewayClient } from '../../llm/gateway-client.js';
import type { FoeMon, LivePosition } from '../../client/decision-battle.js';
import { readBattleEvidence } from '../../client/decision-battle.js';
import { HybridParamsSchema, type HybridParams } from '../../config/schema.js';
import type { RandbatsStats } from '../../types/index.js';
import { dataLoader } from '../../data/data-loader.js';
import {
  appendTeraChoices,
  cloneFromSnapshot,
  hpEval,
  isTeraChoice,
  legalChoices,
  otherSide,
  playChoices,
  snapshot,
  type SideId,
} from '../exact/battle-utils.js';
import { maxDamageChoice } from '../exact/max-damage.js';
import { rankedSwitches } from '../exact/matchup.js';
import type { SearchCtx, SearchImpl, SearchTrace } from '../../config/layers/search.js';
import type { SearchParams } from '../../config/schema.js';
import { battleFromWorld } from './battle.js';
import { emptyLedger, judgeMove, maybeStartPlan, planBonus, type HybridLedger } from './llm.js';
import { regretMatch } from './regret.js';
import { assertRandbatsSpecies, sampleWorlds, type OpponentStyle, type WorldEvidence } from './worlds.js';

const metrics = new WeakMap<object, { costUsd: number; timeouts: number }>();

export function readHybridMetrics(search: object): { llmCostUsd: number; timeouts: number } {
  const row = metrics.get(search);
  return { llmCostUsd: row?.costUsd ?? 0, timeouts: row?.timeouts ?? 0 };
}

export function createHybridSearch(params: SearchParams): SearchImpl {
  const ledger = emptyLedger();
  let client: GatewayClient | null = null;
  const impl: SearchImpl = {
    id: 'hybrid',
    params,
    async search(battle, side, ctx) {
      const hybrid = ctx.hybrid ?? HybridParamsSchema.parse({});
      const trace = await hybridSearch(battle, side, ctx, hybrid, ledger, () => {
        if (!client) {
          client = new GatewayClient({
            timeoutMs: 6000,
            perTurnLatencyBudgetMs: 20000,
            maxRetries: 0,
          });
        }
        return client;
      });
      metrics.set(impl, { costUsd: ledger.costUsd, timeouts: ledger.timeouts });
      return trace;
    },
  };
  metrics.set(impl, { costUsd: 0, timeouts: 0 });
  return impl;
}

async function hybridSearch(
  viewed: Battle,
  side: SideId,
  ctx: SearchCtx,
  params: HybridParams,
  ledger: HybridLedger,
  clientOf: () => GatewayClient,
): Promise<SearchTrace> {
  const evidence = evidenceFrom(viewed, readBattleEvidence(viewed));
  const stats = ctx.randbats ?? await loadRandbats();
  assertRandbatsSpecies(stats);

  const style: OpponentStyle = params.opponent && ledger.plan ? ledger.plan.style : 'balanced';
  const rng = ctx.rng ?? new PRNG([viewed.turn + 1, 2, 3, 4] as never);
  const worlds = sampleWorlds(evidence, params.worlds, stats, rng, style);
  const allowed = ctx.llmAllowed !== false && (ctx.llmCostCapUsd == null || ledger.costUsd < ctx.llmCostCapUsd);
  const client = allowed && (params.plan || params.judgment) ? clientOf() : null;
  maybeStartPlan(ledger, viewed, side, evidence.knownFoes, worlds, params, client, allowed);

  const deadline = ctx.deadlineMs ?? Number.POSITIVE_INFINITY;
  const reserve = params.judgment && allowed ? 3500 : 0;
  const searchDeadline = reserve > 0 ? Math.min(deadline, Date.now() + Math.max(250, deadline - Date.now() - reserve)) : deadline;

  const totals = new Map<string, { score: number; weight: number; ko: number }>();
  let worldsDone = 0;
  for (const world of worlds) {
    if (Date.now() >= searchDeadline && worldsDone > 0) {
      ledger.timeouts += 1;
      break;
    }
    const battle = battleFromWorld(viewed, world, evidence.position);
    if (!battle) continue;
    const matrix = scoreWorld(
      battle,
      side,
      params,
      searchDeadline,
      ledger.plan ? (next, who) => planBonus(next, who, ledger.plan) : null,
      ledger,
    );
    if (!matrix) continue;
    worldsDone += 1;
    for (const row of matrix) {
      const slot = totals.get(row.choice) ?? { score: 0, weight: 0, ko: 0 };
      slot.score += row.score * world.weight;
      slot.ko += row.koRate * world.weight;
      slot.weight += world.weight;
      totals.set(row.choice, slot);
    }
  }

  const rootLegal = appendTeraChoices(viewed, side, legalChoices(viewed, side));
  let scores = [...totals.entries()]
    .filter(([choice]) => rootLegal.includes(choice) || rootLegal.length === 0)
    .map(([choice, slot]) => ({
      choice,
      score: slot.weight > 0 ? slot.score / slot.weight : slot.score,
      koRate: slot.weight > 0 ? slot.ko / slot.weight : 0,
    }));
  if (scores.length === 0) {
    const fallback = rootLegal[0] ? maxDamageChoice(viewed, side, rootLegal.filter(choice => !isTeraChoice(choice))) : 'default';
    return { choice: fallback || 'default', scores: fallback ? [{ choice: fallback, score: 0 }] : [] };
  }
  scores = applyTeraPrior(scores, ledger.plan);
  scores.sort((a, b) => b.score - a.score || a.choice.localeCompare(b.choice));
  let choice = teraGate(scores, viewed, side, params, ledger.plan);

  if (params.judgment && client && allowed && Date.now() < deadline) {
    const judged = await judgeMove(client, params, ledger.plan, scores, deadline - Date.now());
    ledger.costUsd += judged.costUsd;
    if (judged.timeout) ledger.timeouts += 1;
    if (judged.choice && (rootLegal.includes(judged.choice) || rootLegal.length === 0)) choice = judged.choice;
  }

  const switchProb = scores.some(row => row.choice.startsWith('switch'));
  return {
    choice,
    scores: scores.map(row => ({ choice: row.choice, score: row.score })),
    predictedSwitch: switchProb && choice.startsWith('switch'),
    note: `worlds=${worldsDone}/${worlds.length}`,
  };
}

interface ActionRow {
  choice: string;
  score: number;
  koRate: number;
}

function scoreWorld(
  battle: Battle,
  side: SideId,
  params: HybridParams,
  deadline: number,
  bonus: ((battle: Battle, side: SideId) => number) | null,
  ledger: HybridLedger,
): ActionRow[] | null {
  const mine = capActions(battle, side, params.maxActions);
  const replies = capReplies(battle, otherSide(side), params.maxReplies, ledger.plan?.style || 'balanced');
  if (mine.length === 0) return null;
  if (replies.length === 0) replies.push('');
  const snap = snapshot(battle);
  const payoff: number[][] = [];
  const ko: number[][] = [];
  for (const choice of mine) {
    if (Date.now() >= deadline && payoff.length > 0) {
      ledger.timeouts += 1;
      break;
    }
    const values: number[] = [];
    const kos: number[] = [];
    for (let reply = 0; reply < replies.length; reply++) {
      let total = 0;
      let knocked = 0;
      const draws = Math.max(1, params.samples);
      for (let sample = 0; sample < draws; sample++) {
        const next = cloneFromSnapshot(snap);
        reseed(next, sample + payoff.length * 17 + reply);
        const before = faintCount(next, otherSide(side));
        const ok = playChoices(next, side, choice, replies[reply] || undefined);
        const value = (ok ? hpEval(next, side) : hpEval(battle, side)) + (bonus ? bonus(next, side) : 0);
        total += value;
        if (faintCount(next, otherSide(side)) > before) knocked += 1;
      }
      values.push(total / draws);
      kos.push(knocked / draws);
    }
    payoff.push(values);
    ko.push(kos);
  }
  if (payoff.length === 0) return null;
  const usedMine = mine.slice(0, payoff.length);
  const matched = regretMatch(payoff, params.regretIterations);
  return usedMine.map((choice, index) => ({
    choice,
    score: matched.rowValues[index] ?? 0,
    koRate: dot(ko[index] || [], matched.colMix),
  }));
}

function capActions(battle: Battle, side: SideId, cap: number): string[] {
  const base = legalChoices(battle, side);
  const withTera = appendTeraChoices(battle, side, base);
  if (withTera.length <= cap) return withTera;
  const moves = withTera.filter(choice => choice.startsWith('move ') && !isTeraChoice(choice));
  const tera = withTera.filter(choice => isTeraChoice(choice));
  const switches = rankedSwitches(battle, side).map(row => row.choice);
  const kept = [...moves];
  for (const choice of tera) {
    if (kept.length >= cap) break;
    kept.push(choice);
  }
  for (const choice of switches) {
    if (kept.length >= cap) break;
    if (!kept.includes(choice)) kept.push(choice);
  }
  return kept.slice(0, cap);
}

function capReplies(battle: Battle, side: SideId, cap: number, style: OpponentStyle): string[] {
  const legal = legalChoices(battle, side).filter(choice => !isTeraChoice(choice));
  if (legal.length <= cap) return legal;
  const moves = legal.filter(choice => choice.startsWith('move '));
  const switches = legal.filter(choice => choice.startsWith('switch '));
  const status: string[] = [];
  const attacks: string[] = [];
  const active = battle.getSide(side).active[0];
  for (const choice of moves) {
    const index = Number(choice.slice(5)) - 1;
    const id = active?.moveSlots[index]?.id || '';
    const category = Dex.moves.get(id).category;
    if (category === 'Status') status.push(choice);
    else attacks.push(choice);
  }
  let bestAttack = attacks[0];
  if (attacks.length > 1) bestAttack = maxDamageChoice(battle, side, attacks);
  const ordered = style === 'stall'
    ? [...switches.slice(0, 1), ...status, ...(bestAttack ? [bestAttack] : []), ...attacks.filter(choice => choice !== bestAttack)]
    : [...(bestAttack ? [bestAttack] : []), ...attacks.filter(choice => choice !== bestAttack), ...status, ...switches.slice(0, 1)];
  const kept: string[] = [];
  for (const choice of ordered) {
    if (kept.length >= cap) break;
    if (!kept.includes(choice)) kept.push(choice);
  }
  return kept.length ? kept : legal.slice(0, cap);
}

function applyTeraPrior(
  rows: ActionRow[],
  plan: HybridLedger['plan'],
): ActionRow[] {
  if (!plan) return rows;
  return rows.map(row => {
    if (!isTeraChoice(row.choice)) return row;
    if (plan.tera === 'now') return { ...row, score: row.score + 0.25 };
    if (plan.tera === 'hold') return { ...row, score: row.score - 0.15 };
    return row;
  });
}

function teraGate(
  rows: ActionRow[],
  battle: Battle,
  side: SideId,
  params: HybridParams,
  plan: HybridLedger['plan'],
): string {
  const best = rows[0];
  if (!best) return 'default';
  if (!params.tera || !isTeraChoice(best.choice)) return best.choice;
  const plain = rows.find(row => !isTeraChoice(row.choice));
  if (!plain) return best.choice;
  const tera = best;
  if (tera.koRate - plain.koRate >= 0.5) return tera.choice;
  const turn = battle.turn || 0;
  const foeTera = battle.getSide(otherSide(side)).pokemon.some(mon => Boolean(mon?.terastallized));
  let margin = foeTera ? 0.5 : 1;
  if (plan?.tera === 'now') margin = 0.15;
  if (plan?.tera === 'hold' && turn < 10) return plain.choice;
  if (turn < 10 && plan?.tera !== 'now') return plain.choice;
  return tera.score - plain.score >= margin ? tera.choice : plain.choice;
}

function evidenceFrom(viewed: Battle, position: LivePosition | null): WorldEvidence & { position: LivePosition | null } {
  if (position) {
    const known = [position.foeActive, ...(position.foeBench || [])].filter((mon): mon is FoeMon => !!mon?.species);
    return {
      knownFoes: known,
      myHazards: position.myHazards,
      foeHazards: position.foeHazards,
      position,
    };
  }
  const foe = viewed.p2.pokemon.map(mon => ({
    species: mon.species.name,
    level: mon.level,
    hp: mon.hp,
    maxhp: mon.maxhp,
    status: mon.status || undefined,
    ability: mon.ability,
    item: mon.item,
    moves: mon.moveSlots.map(slot => slot.id).filter(id => id && id !== 'tackle' && id !== 'struggle'),
    fainted: mon.fainted,
    terastallized: mon.terastallized || undefined,
  }));
  return { knownFoes: foe, position: null };
}

async function loadRandbats(): Promise<RandbatsStats> {
  try {
    return dataLoader.getStats();
  } catch {
    await dataLoader.load();
    return dataLoader.getStats();
  }
}

function faintCount(battle: Battle, side: SideId): number {
  return battle.getSide(side).pokemon.filter(mon => mon.fainted || mon.hp <= 0).length;
}

function reseed(battle: Battle, sample: number): void {
  const prng = new PRNG([sample + 1, 0x6d2b79f5, 0x1b873593, 0x85ebca6b] as never);
  battle.resetRNG(prng.startingSeed);
}

function dot(left: number[], right: number[]): number {
  let sum = 0;
  for (let i = 0; i < left.length; i++) sum += left[i] * (right[i] ?? 0);
  return sum;
}
