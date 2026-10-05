#!/usr/bin/env node
/**
 * Screen jev-solo. Question design stays the config file.
 * Held-out positions are not opened here.
 *
 *   npm run jev:eval -- screen --games 100
 *   npm run jev:eval -- games --opponent maxdamage --games 100
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { specFromId } from '../engine/exact/policies.js';
import { teamsForSeed } from '../engine/exact/battle-utils.js';
import { runGamesParallel } from '../bench/pool.js';
import type { GameJob } from '../bench/game.js';
import { loadJevSoloConfig } from '../llm/jev-solo/config.js';
import { mergeTotals, percentile, rate, wilson, type JevTotals } from '../llm/jev-solo/stats.js';

interface Summary {
  opponent: string;
  games: number;
  wins: number;
  losses: number;
  ties: number;
  winRate: number;
  ci: [number, number];
  invalid: number;
  crashes: number;
  switchRate: string;
  teraRate: string;
  failureRate: string;
  latencyP50: number;
  latencyP99: number;
  costPerGame: number;
  calls: number;
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function play(opponentId: string, games: number): Promise<Summary> {
  const jev = specFromId('jev-solo');
  const opponent = specFromId(opponentId);
  const pairs = Math.ceil(games / 2);
  const jobs: GameJob[] = [];
  for (let i = 0; i < pairs && jobs.length < games; i++) {
    const seed = 50_000 + i;
    const teams = teamsForSeed(seed);
    jobs.push({ index: jobs.length, seed, p1Team: teams.p1, p2Team: teams.p2, p1: jev, p2: opponent });
    if (jobs.length < games) {
      jobs.push({ index: jobs.length, seed, p1Team: teams.p1, p2Team: teams.p2, p1: opponent, p2: jev });
    }
  }
  console.log(`jev-solo vs ${opponentId}: ${jobs.length} games`);
  const played = await runGamesParallel(jobs, Math.min(4, os.cpus().length));
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let invalid = 0;
  let crashes = 0;
  const totals: JevTotals[] = [];
  for (const game of played) {
    const jevIsP1 = jobs[game.index].p1.kind === 'jev-solo';
    if (game.crashed) crashes++;
    invalid += jevIsP1 ? game.p1Invalid : game.p2Invalid;
    if (game.winner === 'tie') ties++;
    else if ((jevIsP1 && game.winner === 'p1') || (!jevIsP1 && game.winner === 'p2')) wins++;
    else losses++;
    const trace = jevIsP1 ? game.p1Jev : game.p2Jev;
    if (trace) totals.push(trace);
  }
  const merged = mergeTotals(totals);
  const [low, high] = wilson(wins, played.length);
  return {
    opponent: opponentId,
    games: played.length,
    wins,
    losses,
    ties,
    winRate: played.length ? wins / played.length : 0,
    ci: [low, high],
    invalid,
    crashes,
    switchRate: rate(merged.hardSwitches, merged.switchOpportunities),
    teraRate: rate(merged.teras, merged.teraOpportunities),
    failureRate: rate(merged.failures, merged.calls),
    latencyP50: percentile(merged.latenciesMs, 50),
    latencyP99: percentile(merged.latenciesMs, 99),
    costPerGame: played.length ? merged.costUsd / played.length : 0,
    calls: merged.calls,
  };
}

function printSummary(summary: Summary): void {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  console.log(
    [
      `${summary.opponent}: ${summary.wins}W-${summary.losses}L-${summary.ties}T`,
      `win rate ${pct(summary.winRate)} CI [${pct(summary.ci[0])}, ${pct(summary.ci[1])}]`,
      `switch ${summary.switchRate} tera ${summary.teraRate}`,
      `latency p50 ${summary.latencyP50}ms p99 ${summary.latencyP99}ms`,
      `cost/game $${summary.costPerGame.toFixed(5)} calls ${summary.calls}`,
      `failures ${summary.failureRate} invalid ${summary.invalid} crashes ${summary.crashes}`,
    ].join(' | ')
  );
}

async function main(): Promise<void> {
  if (!process.env.VERCEL_AI_GATEWAY_KEY && !process.env.AI_GATEWAY_API_KEY) {
    throw new Error('Set VERCEL_AI_GATEWAY_KEY before screening. Fallback games are not a Jev result.');
  }
  const command = process.argv[2] || 'screen';
  const games = Number(arg('--games', '100'));
  const config = loadJevSoloConfig();
  console.log(`config ${config.id} question=${config.question} criteria=${config.criteria}`);
  const opponents = command === 'games' ? [arg('--opponent', 'maxdamage')] : ['maxdamage', 'exact-1ply'];
  const summaries: Summary[] = [];
  for (const opponent of opponents) summaries.push(await play(opponent, games));
  for (const summary of summaries) printSummary(summary);
  const out = path.join(process.cwd(), 'experiments', 'jev-solo', 'screen.json');
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), config, summaries }, null, 2));
  console.log(`wrote ${out}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
