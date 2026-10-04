import { PolicySpec } from '../engine/exact/policies.js';
import { EXACT_1PLY, ExactConfig } from '../engine/exact/search.js';
import { runDiagnosticSuite } from '../engine/exact/diagnostics.js';
import { teamsForSeed } from '../engine/exact/battle-utils.js';
import { GameJob, GameResult } from './game.js';
import { p99, runGamesParallel } from './pool.js';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function policy(name: string): PolicySpec {
  if (name === 'random') return { kind: 'random' };
  if (name === 'maxdamage') return { kind: 'maxdamage' };
  if (name === 'legacy') return { kind: 'legacy' };
  const [depth, model, evalMode] = name.replace(/^exact:?/, '').split(',') ;
  if (name === 'exact' || name.startsWith('exact')) {
    const config: ExactConfig = {
      depth: Number(depth) || EXACT_1PLY.depth,
      opponentModel: model === 'uniform' ? 'uniform' : 'max-damage',
      evalMode: evalMode === 'full' ? 'full' : 'hp',
      errorAsLoss: name.includes(',loss'),
    };
    return { kind: 'exact', config };
  }
  throw new Error(`Unknown policy ${name}`);
}

function pairedJobs(pairs: number, a: PolicySpec, b: PolicySpec, seedStart: number): GameJob[] {
  const jobs: GameJob[] = [];
  for (let i = 0; i < pairs; i++) {
    const seed = seedStart + i;
    const teams = teamsForSeed(seed);
    jobs.push({
      index: jobs.length,
      seed,
      p1Team: teams.p1,
      p2Team: teams.p2,
      p1: a,
      p2: b,
    });
    jobs.push({
      index: jobs.length,
      seed,
      p1Team: teams.p1,
      p2Team: teams.p2,
      p1: b,
      p2: a,
    });
  }
  return jobs;
}

export function scoreCandidate(results: GameResult[], jobs: GameJob[], candidate: PolicySpec): {
  wins: number;
  losses: number;
  ties: number;
  games: number;
  winRate: number;
  invalid: number;
  crashes: number;
  p99ms: number;
  maxMs: number;
} {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let invalid = 0;
  let crashes = 0;
  const times: number[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const job = jobs[i];
    const side = JSON.stringify(job.p1) === JSON.stringify(candidate) ? 'p1' : 'p2';
    if (result.crashed) crashes++;
    if (result.winner === 'tie') ties++;
    else if (result.winner === side) wins++;
    else losses++;
    invalid += side === 'p1' ? result.p1Invalid : result.p2Invalid;
    times.push(...(side === 'p1' ? result.p1TurnTimes : result.p2TurnTimes));
  }
  const games = results.length;
  return {
    wins,
    losses,
    ties,
    games,
    winRate: games ? wins / games : 0,
    invalid,
    crashes,
    p99ms: p99(times),
    maxMs: times.length ? Math.max(...times) : 0,
  };
}

async function main() {
  if (process.argv.includes('--diagnostics')) {
    const result = runDiagnosticSuite(EXACT_1PLY);
    process.exit(result.failed === 0 ? 0 : 1);
  }

  const pairs = Number(arg('pairs', '10'));
  const a = policy(arg('a', 'exact'));
  const b = policy(arg('b', 'random'));
  const seed = Number(arg('seed', '1'));
  console.log(`Paired benchmark: ${pairs} seeds x 2 sides`);
  console.log(`A: ${JSON.stringify(a)}`);
  console.log(`B: ${JSON.stringify(b)}`);
  const jobs = pairedJobs(pairs, a, b, seed);
  const started = Date.now();
  const results = await runGamesParallel(jobs);
  const summary = scoreCandidate(results, jobs, a);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log('\n=== Result ===');
  console.log(`A win rate: ${(summary.winRate * 100).toFixed(1)}% (${summary.wins}W-${summary.losses}L-${summary.ties}T / ${summary.games})`);
  console.log(`invalid=${summary.invalid} crashes=${summary.crashes} p99=${summary.p99ms.toFixed(0)}ms max=${summary.maxMs.toFixed(0)}ms`);
  console.log(`elapsed ${seconds}s`);
  const errors = results.filter(r => r.crashed).slice(0, 3);
  for (const error of errors) console.log(`crash seed=${error.seed}: ${error.error}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
