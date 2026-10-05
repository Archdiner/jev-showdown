import { informationMode, type InformationMode } from '../client/hidden-info.js';
import { dataLoader } from '../data/data-loader.js';
import { publishDataResult } from '../data/publish.js';
import { gen9RandomBattle } from '../formats/gen9-randombattle.js';
import { specForAlias } from '../config/aliases.js';
import { BenchPlayer, GameJob, GameResult, playerId } from './game.js';
import { runDiagnosticSuite } from '../engine/exact/diagnostics.js';
import { EXACT_1PLY, EXACT_1PLY_QW, ExactConfig, FITTED_1PLY, FITTED_DEPTH2, SWITCH_DEPTH2 } from '../engine/exact/search.js';
import { assertRandbatsSpecies, randbatsSpeciesCount, statsFileSpeciesCount } from '../engine/exact/team-features.js';
import { wilson } from '../dashboard/stats.js';
import { teamsForSeed } from '../engine/exact/battle-utils.js';
import { p99, runGamesParallel } from './pool.js';
import { specFromId } from '../engine/exact/policies.js';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

/** Engine names play the policy directly. Config aliases and file paths play through buildBot. */
function policy(name: string): BenchPlayer {
  if (name === 'random') return { kind: 'random' };
  if (name === 'maxdamage') return { kind: 'maxdamage' };
  if (name === 'legacy') return { kind: 'legacy' };
  if (name === 'exact') return { kind: 'exact', config: EXACT_1PLY };
  if (name === 'fitted' || name === 'fitted-1ply') return { kind: 'exact', config: FITTED_1PLY };
  if (name === 'fitted-depth2' || name === 'fitted-d2') return { kind: 'exact', config: FITTED_DEPTH2 };
  if (name === 'qw' || name === 'exact-qw') return { kind: 'exact', config: EXACT_1PLY_QW };
  if (name === 'switch') return { kind: 'exact', config: SWITCH_DEPTH2 };
  if (name.startsWith('exact:')) {
    const [, depth, model, evalMode] = name.split(':');
    const config: ExactConfig = {
      depth: Number(depth) || EXACT_1PLY.depth,
      opponentModel: model === 'uniform' ? 'uniform' : model === 'switch' ? 'switch' : 'max-damage',
      evalMode: evalMode === 'team' ? 'team' : evalMode === 'full' ? 'full' : 'hp',
      errorAsLoss: name.includes(',loss'),
      samples: 1,
    };
    return { kind: 'exact', config };
  }
  
  // Try to resolve as a policy ID first
  try {
    const spec = specFromId(name);
    return spec;
  } catch {
    // Fall back to config alias (file path)
    return specForAlias(name, 'selfplay');
  }
}

function usesFitted(player: BenchPlayer): boolean {
  if (!('kind' in player) || player.kind !== 'exact') return false;
  return player.config.evalMode === 'fitted';
}

function informationArg(): InformationMode {
  const raw = arg('information', '');
  if (!raw) return informationMode();
  if (raw !== 'hidden' && raw !== 'full') throw new Error('--information must be hidden or full');
  return raw;
}

function pairedJobs(
  pairs: number,
  a: BenchPlayer,
  b: BenchPlayer,
  seedStart: number,
  information: InformationMode,
): GameJob[] {
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
      information,
    });
    jobs.push({
      index: jobs.length,
      seed,
      p1Team: teams.p1,
      p2Team: teams.p2,
      p1: b,
      p2: a,
      information,
    });
  }
  return jobs;
}

/** Wilson score interval. Ties stay in the denominator, so a tie is not a win. */
export function wilsonCI(wins: number, total: number): [number, number] {
  if (total <= 0) return [0, 1];
  const z = 1.96;
  const p = wins / total;
  const denom = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

export function scoreCandidate(results: GameResult[], jobs: GameJob[], candidate: BenchPlayer): {
  wins: number;
  losses: number;
  ties: number;
  games: number;
  winRate: number;
  invalid: number;
  crashes: number;
  p99ms: number;
  p50ms: number;
  p95ms: number;
  maxMs: number;
} {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let invalid = 0;
  let crashes = 0;
  const times: number[] = [];
  const candidateId = playerId(candidate);
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const job = jobs[i];
    const side = playerId(job.p1) === candidateId ? 'p1' : 'p2';
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
    p50ms: percentile(times, 0.5),
    p95ms: percentile(times, 0.95),
    maxMs: times.length ? Math.max(...times) : 0,
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function playRate(results: GameResult[], jobs: GameJob[], candidate: BenchPlayer): {
  decisions: number;
  switches: number;
  predicted: number;
  answered: number;
  switchRate: number;
  punishRate: number;
} {
  let decisions = 0;
  let switches = 0;
  let predicted = 0;
  let answered = 0;
  const candidateId = playerId(candidate);
  for (let i = 0; i < results.length; i++) {
    const side = playerId(jobs[i].p1) === candidateId ? 'p1' : 'p2';
    if (side === 'p1') {
      decisions += results[i].p1Decisions || 0;
      switches += results[i].p1Switches || 0;
      predicted += results[i].p1Predicted || 0;
      answered += results[i].p1Answered || 0;
    } else {
      decisions += results[i].p2Decisions || 0;
      switches += results[i].p2Switches || 0;
      predicted += results[i].p2Predicted || 0;
      answered += results[i].p2Answered || 0;
    }
  }
  return {
    decisions,
    switches,
    predicted,
    answered,
    switchRate: decisions ? switches / decisions : 0,
    punishRate: predicted ? answered / predicted : 0,
  };
}

async function main() {
  if (process.argv.includes('--diagnostics')) {
    const result = runDiagnosticSuite(EXACT_1PLY);
    process.exit(result.failed === 0 ? 0 : 1);
  }

  await dataLoader.load(gen9RandomBattle);
  const pairs = Number(arg('pairs', '10'));
  const a = policy(arg('a', 'exact'));
  const b = policy(arg('b', 'random'));
  const seed = Number(arg('seed', '1'));
  const information = informationArg();
  const species = randbatsSpeciesCount();
  const statsSpecies = statsFileSpeciesCount();
  console.log(`randbats generator species=${species} statsFile=${statsSpecies ?? 'missing'}`);
  if (usesFitted(a) || usesFitted(b)) assertRandbatsSpecies();
  console.log(`Paired benchmark: ${pairs} seeds x 2 sides, information=${information}`);
  console.log(`A: ${JSON.stringify(a)}`);
  console.log(`B: ${JSON.stringify(b)}`);
  const jobs = pairedJobs(pairs, a, b, seed, information);
  const started = Date.now();
  const results = await runGamesParallel(jobs);
  const summary = scoreCandidate(results, jobs, a);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log('\n=== Result ===');
  console.log(`A win rate: ${(summary.winRate * 100).toFixed(1)}% (${summary.wins}W-${summary.losses}L-${summary.ties}T / ${summary.games})`);
  const decided = summary.wins + summary.losses;
  const interval = wilson(summary.wins, decided > 0 ? decided : summary.games);
  const pct = (value: number | null) => value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
  console.log(`Wilson 95% CI: [${pct(interval.low)}, ${pct(interval.high)}]`);
  const viewMiss = results.reduce((sum, game) => sum + game.p1ViewMiss + game.p2ViewMiss, 0);
  console.log(`invalid=${summary.invalid} crashes=${summary.crashes} viewMiss=${viewMiss} p50=${summary.p50ms.toFixed(0)}ms p95=${summary.p95ms.toFixed(0)}ms p99=${summary.p99ms.toFixed(0)}ms max=${summary.maxMs.toFixed(0)}ms`);
  const play = playRate(results, jobs, a);
  console.log(`switch rate ${(play.switchRate * 100).toFixed(1)}% (${play.switches}/${play.decisions}) predicted-switch punish ${(play.punishRate * 100).toFixed(1)}% (${play.answered}/${play.predicted})`);
  console.log(`elapsed ${seconds}s`);
  const errors = results.filter(r => r.crashed).slice(0, 3);
  for (const error of errors) console.log(`crash seed=${error.seed}: ${error.error}`);
  publishDataResult('logs/bench.json', {
    pairs,
    information,
    summary,
    viewMiss,
    play,
    seconds: Number(seconds),
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
