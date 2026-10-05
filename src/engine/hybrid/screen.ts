import { dataLoader } from '../../data/data-loader.js';
import { specForAlias } from '../../config/aliases.js';
import { wilson } from '../../dashboard/stats.js';
import { teamsForSeed } from '../exact/battle-utils.js';
import { EXACT_1PLY } from '../exact/search.js';
import type { BenchPlayer, GameJob, GameResult } from '../../bench/game.js';
import { playerId } from '../../bench/game.js';
import { runGamesParallel } from '../../bench/pool.js';
import { assertRandbatsSpecies } from './worlds.js';

const VARIANTS = [
  'hybrid-core',
  'hybrid-plan',
  'hybrid',
  'hybrid-every-qwen',
  'hybrid-every-qwen-wide',
  'hybrid-every-opus',
  'hybrid-every-grok',
] as const;
const OPPONENTS = ['exact', 'maxdamage'] as const;

function arg(name: string, fallback: string): string {
  const hit = process.argv.find(item => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function opponent(name: (typeof OPPONENTS)[number]): BenchPlayer {
  if (name === 'maxdamage') return { kind: 'maxdamage' };
  return { kind: 'exact', config: EXACT_1PLY };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function summarize(results: GameResult[], jobs: GameJob[], candidate: BenchPlayer) {
  const id = playerId(candidate);
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let invalid = 0;
  let crashes = 0;
  let cost = 0;
  let timeouts = 0;
  const times: number[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const side = playerId(jobs[i].p1) === id ? 'p1' : 'p2';
    if (result.crashed) crashes++;
    if (result.winner === 'tie') ties++;
    else if (result.winner === side) wins++;
    else losses++;
    invalid += side === 'p1' ? result.p1Invalid : result.p2Invalid;
    cost += side === 'p1' ? result.p1LlmCostUsd : result.p2LlmCostUsd;
    timeouts += side === 'p1' ? result.p1Timeouts : result.p2Timeouts;
    times.push(...(side === 'p1' ? result.p1TurnTimes : result.p2TurnTimes));
  }
  const games = results.length;
  const interval = wilson(wins, games);
  return {
    games,
    wins,
    losses,
    ties,
    invalid,
    crashes,
    timeouts,
    llmCostPerGame: games ? cost / games : 0,
    p50ms: percentile(times, 0.5),
    p95ms: percentile(times, 0.95),
    wilson95: [interval.low, interval.high],
  };
}

async function main(): Promise<void> {
  await dataLoader.load();
  const stats = dataLoader.getStats();
  assertRandbatsSpecies(stats);
  const pairs = Number(arg('pairs', '52'));
  const concurrency = Number(arg('concurrency', '4'));
  const only = arg('variant', '');
  const onlyOpp = arg('opponent', '');
  const variants = VARIANTS.filter(name => !only || name === only);
  const opponents = OPPONENTS.filter(name => !onlyOpp || name === onlyOpp);
  console.log(`species=${Object.keys(stats).length} pairs=${pairs} concurrency=${concurrency}`);
  const report: Record<string, ReturnType<typeof summarize>> = {};
  for (const variant of variants) {
    const candidate = specForAlias(variant, 'ladder');
    for (const name of opponents) {
      const other = opponent(name);
      const jobs: GameJob[] = [];
      for (let i = 0; i < pairs; i++) {
        const seed = 1000 + i;
        const teams = teamsForSeed(seed);
        jobs.push({ index: jobs.length, seed, p1Team: teams.p1, p2Team: teams.p2, p1: candidate, p2: other, information: 'hidden' });
        jobs.push({ index: jobs.length, seed, p1Team: teams.p1, p2Team: teams.p2, p1: other, p2: candidate, information: 'hidden' });
      }
      const started = Date.now();
      const results = await runGamesParallel(jobs, concurrency);
      const summary = summarize(results, jobs, candidate);
      const key = `${variant} vs ${name}`;
      report[key] = summary;
      const ci = summary.wilson95.map(value => `${((value ?? 0) * 100).toFixed(1)}%`).join('–');
      console.log(
        `${key}: ${summary.wins}W-${summary.losses}L-${summary.ties}T / ${summary.games} ` +
        `CI ${ci} invalid=${summary.invalid} crashes=${summary.crashes} timeouts=${summary.timeouts} ` +
        `p50=${summary.p50ms.toFixed(0)}ms p95=${summary.p95ms.toFixed(0)}ms ` +
        `llmCost/game=$${summary.llmCostPerGame.toFixed(5)} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
    }
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
