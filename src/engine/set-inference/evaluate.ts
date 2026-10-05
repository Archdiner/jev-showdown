import { Dex, PRNG, type Battle } from '@pkmn/sim';
import { viewerLines } from '../../client/hidden-info.js';
import { splitFor } from '../../config/positions.js';
import type { RandbatsStats } from '../../types/index.js';
import {
  legalChoices,
  safeChoose,
  startRandomBattle,
  teamsForSeed,
  type SideId,
} from '../exact/battle-utils.js';
import { lookupSpecies, toId } from './catalog.js';
import {
  SetInference,
  probabilityOf,
  topOf,
  type OurSet,
  type RevealEvent,
} from './index.js';

const EPS = 1e-6;

export interface SliceMetrics {
  events: number;
  logLoss: number;
  baselineLogLoss: number;
  top1: number;
  baselineTop1: number;
  meanPTrue: number;
  baselineMeanPTrue: number;
  ece: number;
  baselineEce: number;
  zeroProb: number;
  baselineZeroProb: number;
}

export interface EvalReport {
  games: number;
  devGames: number;
  heldOutGames: number;
  crashes: number;
  dev: Record<RevealEvent['kind'], SliceMetrics>;
  heldOut: Record<RevealEvent['kind'], SliceMetrics>;
}

interface Scored {
  split: 'dev' | 'held-out';
  kind: RevealEvent['kind'];
  truth: string;
  pModel: number;
  pPrior: number;
  topModel: string;
  topPrior: string;
  pTopModel: number;
  pTopPrior: number;
}

export function evaluateSets(options: {
  stats: RandbatsStats;
  games?: number;
  seedStart?: number;
  maxTurns?: number;
}): EvalReport {
  const games = options.games ?? 40;
  const seedStart = options.seedStart ?? 1;
  const scored: Scored[] = [];
  let crashes = 0;
  let devGames = 0;
  let heldOutGames = 0;
  for (let i = 0; i < games; i++) {
    const seed = seedStart + i;
    const split = splitFor(String(seed));
    if (split === 'held-out') heldOutGames++;
    else devGames++;
    let battle: Battle;
    try {
      battle = play(seed, options.maxTurns ?? 36);
    } catch {
      crashes++;
      continue;
    }
    try {
      scored.push(...scoreBattle(battle, 'p1', options.stats, split));
      scored.push(...scoreBattle(battle, 'p2', options.stats, split));
    } catch {
      crashes++;
    }
  }
  return {
    games,
    devGames,
    heldOutGames,
    crashes,
    dev: summarize(scored.filter(row => row.split === 'dev')),
    heldOut: summarize(scored.filter(row => row.split === 'held-out')),
  };
}

export function formatEvalReport(report: EvalReport): string {
  const lines = [
    `games=${report.games} devGames=${report.devGames} heldOutGames=${report.heldOutGames} crashes=${report.crashes}`,
  ];
  for (const split of ['dev', 'heldOut'] as const) {
    for (const kind of ['move', 'item', 'tera'] as const) {
      const row = report[split][kind];
      lines.push(
        `${split} ${kind} n=${row.events} logLoss=${num(row.logLoss)} baseline=${num(row.baselineLogLoss)} ` +
        `top1=${num(row.top1)} baselineTop1=${num(row.baselineTop1)} ` +
        `meanP=${num(row.meanPTrue)} baselineMeanP=${num(row.baselineMeanPTrue)} ` +
        `ece=${num(row.ece)} baselineEce=${num(row.baselineEce)} ` +
        `zero=${row.zeroProb} baselineZero=${row.baselineZeroProb}`,
      );
    }
  }
  return lines.join('\n');
}

function play(seed: number, maxTurns: number): Battle {
  const teams = teamsForSeed(seed);
  const battle = startRandomBattle(teams.p1, teams.p2, seed);
  const rng = new PRNG([seed >>> 0, 3, 5, 7] as never);
  let guard = 0;
  while (!battle.ended && battle.turn < maxTurns && guard < 250) {
    guard++;
    const p1 = legalChoices(battle, 'p1');
    const p2 = legalChoices(battle, 'p2');
    if (p1.length === 0 && p2.length === 0) break;
    if (p1.length) choose(battle, 'p1', p1[rng.random(p1.length)] || p1[0], rng);
    if (!battle.ended && p2.length) choose(battle, 'p2', p2[rng.random(p2.length)] || p2[0], rng);
  }
  return battle;
}

/**
 * Random legal play. One in four move choices terastallizes when the request
 * allows it, so a Tera type is revealed often enough to score. The rate is
 * not fit to the log-loss.
 */
function choose(battle: Battle, side: SideId, choice: string, rng: PRNG): void {
  if (choice.startsWith('move ') && rng.random(4) === 0) {
    const req = battle.getSide(side).activeRequest as { active?: Array<{ canTerastallize?: string }> } | null;
    if (req?.active?.[0]?.canTerastallize) {
      try {
        if (battle.choose(side, `${choice} terastallize`)) return;
      } catch {
        // The sim rejected the tera choice. Fall through to the plain move.
      }
      try {
        battle.getSide(side).clearChoice();
      } catch {
        // already clear
      }
    }
  }
  safeChoose(battle, side, choice);
}

function scoreBattle(battle: Battle, viewer: SideId, stats: RandbatsStats, split: Scored['split']): Scored[] {
  const model = new SetInference(stats, { ourSide: () => viewer, seed: 1 });
  const prior = new SetInference(stats, { ourSide: () => viewer, priorOnly: true, seed: 1 });
  const ours = ourSets(battle, viewer);
  model.attachOurTeam(ours);
  prior.attachOurTeam(ours);
  const out: Scored[] = [];
  for (const line of viewerLines(battle.log, viewer)) {
    const reveal = model.upcoming(line);
    if (reveal && lookupSpecies(stats, reveal.species)) {
      const modelRows = distribution(model, reveal);
      const priorRows = distribution(prior, reveal);
      if (modelRows.length && priorRows.length) {
        out.push({
          split,
          kind: reveal.kind,
          truth: reveal.truth,
          pModel: probabilityOf(modelRows, reveal.truth),
          pPrior: probabilityOf(priorRows, reveal.truth),
          topModel: topOf(modelRows),
          topPrior: topOf(priorRows),
          pTopModel: modelRows[0]?.probability || 0,
          pTopPrior: priorRows[0]?.probability || 0,
        });
      }
    }
    model.observe(line);
    prior.observe(line);
  }
  return out;
}

function distribution(inference: SetInference, reveal: RevealEvent) {
  if (reveal.kind === 'move') return inference.moveDistribution(reveal.species);
  if (reveal.kind === 'item') return inference.itemDistribution(reveal.species);
  return inference.teraDistribution(reveal.species);
}

function ourSets(battle: Battle, side: SideId): OurSet[] {
  return battle.getSide(side).pokemon.map(mon => ({
    species: mon.species.name,
    level: mon.level,
    ability: Dex.abilities.get(mon.ability).name || undefined,
    item: Dex.items.get(mon.item).name || undefined,
    evs: mon.set?.evs,
    ivs: mon.set?.ivs,
  }));
}

function summarize(rows: Scored[]): Record<RevealEvent['kind'], SliceMetrics> {
  return {
    move: slice(rows.filter(row => row.kind === 'move')),
    item: slice(rows.filter(row => row.kind === 'item')),
    tera: slice(rows.filter(row => row.kind === 'tera')),
  };
}

function slice(rows: Scored[]): SliceMetrics {
  if (rows.length === 0) {
    return {
      events: 0, logLoss: 0, baselineLogLoss: 0, top1: 0, baselineTop1: 0,
      meanPTrue: 0, baselineMeanPTrue: 0, ece: 0, baselineEce: 0, zeroProb: 0, baselineZeroProb: 0,
    };
  }
  const logLoss = mean(rows.map(row => -Math.log(Math.min(1, Math.max(row.pModel, EPS)))));
  const baselineLogLoss = mean(rows.map(row => -Math.log(Math.min(1, Math.max(row.pPrior, EPS)))));
  return {
    events: rows.length,
    logLoss,
    baselineLogLoss,
    top1: mean(rows.map(row => toId(row.topModel) === toId(row.truth) ? 1 : 0)),
    baselineTop1: mean(rows.map(row => toId(row.topPrior) === toId(row.truth) ? 1 : 0)),
    meanPTrue: mean(rows.map(row => row.pModel)),
    baselineMeanPTrue: mean(rows.map(row => row.pPrior)),
    ece: expectedCalibrationError(rows.map(row => ({
      pTop: row.pTopModel,
      correct: toId(row.topModel) === toId(row.truth),
    }))),
    baselineEce: expectedCalibrationError(rows.map(row => ({
      pTop: row.pTopPrior,
      correct: toId(row.topPrior) === toId(row.truth),
    }))),
    zeroProb: rows.filter(row => row.pModel <= 0).length,
    baselineZeroProb: rows.filter(row => row.pPrior <= 0).length,
  };
}

function expectedCalibrationError(rows: Array<{ pTop: number; correct: boolean }>): number {
  const bins = Array.from({ length: 10 }, () => ({ n: 0, conf: 0, acc: 0 }));
  for (const row of rows) {
    const confidence = Math.min(1, Math.max(0, row.pTop));
    const index = Math.min(9, Math.floor(confidence * 10));
    bins[index].n++;
    bins[index].conf += confidence;
    bins[index].acc += row.correct ? 1 : 0;
  }
  const total = rows.length || 1;
  let error = 0;
  for (const bin of bins) {
    if (!bin.n) continue;
    error += (bin.n / total) * Math.abs(bin.acc / bin.n - bin.conf / bin.n);
  }
  return error;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function num(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4) : 'na';
}
