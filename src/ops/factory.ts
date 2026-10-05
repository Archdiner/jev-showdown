import { battleFromInputLog } from '../config/adapters.js';
import type { PositionRecord } from '../config/interfaces.js';
import { loadConfig, toSpec } from '../config/load.js';
import { loadPool } from '../config/positions.js';
import { exactSearch } from '../engine/exact/search.js';
import { ablate } from '../exp/ablate.js';
import { playPaired } from '../exp/play.js';
import { liveProposalAllowed, sprt, sprtMaxGames, tallySide } from './sprt.js';
import { sweep } from '../exp/sweep.js';
import { tournament } from '../exp/tournament.js';
import { recordRejected, recordTested } from './cycle.js';
import { openDb } from './db.js';
import { enqueueOpenHypotheses, hypothesisGames } from './hypotheses.js';
import { beat } from './heartbeat.js';
import type { OpsPaths } from './paths.js';
import { readJsonl } from './paths.js';
import {
  challengerCanContinue,
  claimNext,
  completeJob,
  reopenContinuable,
  type Handoff,
  type Proposal,
  type QueueJob,
  type SprtProgress,
} from './queue.js';

export interface FactoryRunOptions {
  once?: boolean;
  /** Stop an inconclusive SPRT here. Defaults to OPS_SPRT_MAX_GAMES. Not part of the job key. */
  maxGames?: number;
  play?: typeof playPaired;
}

interface Outcome {
  resultId: string;
  summary: string;
  proposal?: Proposal;
  rejectedReason?: string;
  /** SPRT is still `continue` and the budget is not spent. Leave the job open. */
  requeue?: boolean;
  progress?: SprtProgress;
  handoff?: Handoff;
}

/**
 * Runs queued experiments and may attach a proposal.
 * It does not write champion or live-approved labels.
 */
export async function runFactory(paths: OpsPaths, opts: FactoryRunOptions = {}): Promise<number> {
  beat(paths, 'factory', 'ok', 'up');
  const maxGames = opts.maxGames ?? sprtMaxGames();
  let ran = 0;
  do {
    reopenContinuable(paths, maxGames);
    const job = claimNext(paths, maxGames);
    if (!job) {
      const added = seedHypotheses(paths);
      if (added > 0) {
        beat(paths, 'factory', 'ok', `queued ${added} hypothesis variants`);
        continue;
      }
      beat(paths, 'factory', 'ok', 'idle');
      if (opts.once) break;
      await new Promise(resolve => setTimeout(resolve, 2000));
      continue;
    }
    try {
      if (alreadyDone(paths, job, maxGames)) {
        ran += 1;
        continue;
      }
      const outcome = await execute(paths, job, opts, maxGames);
      if (outcome.requeue) {
        completeJob(paths, job.id, { resultId: outcome.resultId, status: 'open', progress: outcome.progress });
      } else {
        completeJob(paths, job.id, {
          resultId: outcome.resultId,
          proposal: outcome.proposal,
          status: 'done',
          progress: outcome.progress,
          handoff: outcome.handoff,
        });
        recordTested(paths, outcome.summary);
        if (outcome.rejectedReason) recordRejected(paths, outcome.rejectedReason);
      }
      beat(paths, 'factory', 'ok', outcome.summary);
      ran += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = (job.attempts ?? 0) + 1;
      completeJob(paths, job.id, { status: attempts >= 3 ? 'rejected' : 'open', attempts });
      if (attempts >= 3) recordRejected(paths, message);
      beat(paths, 'factory', 'error', message);
      if (opts.once) break;
    }
    if (opts.once) break;
  } while (!opts.once);
  beat(paths, 'factory', 'stopped', 'exit');
  return ran;
}

function alreadyDone(paths: OpsPaths, job: QueueJob, maxGames: number): boolean {
  const db = openDb(paths);
  try {
    const id = resultId(job);
    const node = db.getNode(id);
    if (!node) return false;
    const metrics = node.metrics && typeof node.metrics === 'object' ? node.metrics as Record<string, unknown> : null;
    if (challengerCanContinue(job, metrics, maxGames)) return false;
    completeJob(paths, job.id, { resultId: id, status: 'done' });
    return true;
  } finally {
    db.close();
  }
}

function seedHypotheses(paths: OpsPaths): number {
  const db = openDb(paths);
  try {
    return enqueueOpenHypotheses(paths, db);
  } finally {
    db.close();
  }
}

async function execute(paths: OpsPaths, job: QueueJob, opts: FactoryRunOptions, maxGames: number): Promise<Outcome> {
  if (job.spec.kind === 'challenger') return runChallenger(paths, job, opts, maxGames);
  if (job.spec.kind === 'sweep') return runSweep(paths, job);
  if (job.spec.kind === 'ablation') return runAblation(paths, job);
  if (job.spec.kind === 'tournament') return runTournament(paths, job);
  return runPositionReplay(paths, job);
}

async function runChallenger(paths: OpsPaths, job: QueueJob, opts: FactoryRunOptions, maxGames: number): Promise<Outcome> {
  const challengerPath = job.spec.challenger || 'configs/champion.yaml';
  const challenger = loadConfig(challengerPath);
  const opponent = loadConfig(job.spec.opponent || 'configs/panel/maxdamage.yaml');
  const batch = evenGames(job.spec.games ?? hypothesisGames());
  const prior = job.progress;
  const seed = prior?.seed ?? 1000;
  const play = opts.play ?? playPaired;
  const results = await play(toSpec(challenger, 'selfplay'), toSpec(opponent, 'selfplay'), batch, seed, false);
  const tally = tallySide(results.map(game => ({
    winner: game.winner,
    p1Id: game.p1ConfigId,
    p2Id: game.p2ConfigId,
    p1Invalid: game.p1Invalid,
    p2Invalid: game.p2Invalid,
    crashed: game.crashed,
  })), challenger.configId);
  const wins = (prior?.wins ?? 0) + tally.wins;
  const losses = (prior?.losses ?? 0) + tally.losses;
  const invalid = (prior?.invalid ?? 0) + tally.invalid;
  const crashes = (prior?.crashes ?? 0) + tally.crashes;
  const playedGames = (prior?.games ?? 0) + results.length;
  const nextSeed = seed + Math.floor(results.length / 2);
  const verdict = sprt(wins, losses);
  const summary = `${wins}/${playedGames} wins, invalid ${invalid}, SPRT ${verdict}`;
  const progress: SprtProgress = {
    wins,
    losses,
    games: playedGames,
    invalid,
    crashes,
    sprt: verdict,
    seed: nextSeed,
    configId: challenger.configId,
  };
  const resultId = writeResult(paths, job, summary, { ...progress });
  const terminal = results.length === 0 || verdict !== 'continue' || playedGames >= maxGames;
  if (!terminal) return { resultId, summary, requeue: true, progress };
  // Self-play gate (INC-041): any invalid choice fails the config.
  const guardrailFail = invalid > 0 || crashes > 0;
  if (liveProposalAllowed(wins, losses, invalid) && !guardrailFail) {
    return {
      resultId,
      summary,
      progress,
      proposal: {
        action: 'live-approved',
        configPath: challengerPath,
        configId: challenger.configId,
        summary,
      },
    };
  }
  return {
    resultId,
    summary,
    progress,
    rejectedReason: guardrailFail
      ? `guardrail failed: invalid=${invalid} crashes=${crashes}`
      : verdict === 'reject' ? summary : undefined,
    handoff: {
      configPath: challengerPath,
      configId: challenger.configId,
      wins,
      losses,
      invalid,
      crashes,
      games: playedGames,
      sprt: verdict,
      opponent: 'max-damage',
    },
  };
}

async function runSweep(paths: OpsPaths, job: QueueJob): Promise<{ resultId: string; summary: string; proposal?: Proposal }> {
  const base = loadConfig(job.spec.base || job.spec.challenger || 'configs/champion.yaml');
  const opponent = loadConfig(job.spec.opponent || 'configs/panel/maxdamage.yaml');
  const rows = await sweep({
    base: base.config,
    opponent: toSpec(opponent, 'selfplay'),
    axes: job.spec.axes || [],
    method: 'grid',
    games: evenGames(job.spec.games ?? 2),
    seedStart: 2000,
    env: 'selfplay',
    devWeight: 0,
  });
  const best = [...rows].sort((a, b) => b.score - a.score)[0];
  const summary = best ? `best score ${best.score.toFixed(3)} over ${rows.length} configs` : 'empty sweep';
  return { resultId: writeResult(paths, job, summary, { rows: rows.length, best: best?.configId }), summary };
}

async function runAblation(paths: OpsPaths, job: QueueJob): Promise<{ resultId: string; summary: string }> {
  const base = loadConfig(job.spec.base || 'configs/champion.yaml');
  const opponent = loadConfig(job.spec.opponent || 'configs/panel/maxdamage.yaml');
  const rows = await ablate({
    config: base.config,
    opponent: toSpec(opponent, 'selfplay'),
    games: evenGames(job.spec.games ?? 2),
    seedStart: 3000,
    env: 'selfplay',
    devWeight: 0,
  });
  const summary = `${rows.length} ablations`;
  return { resultId: writeResult(paths, job, summary, { rows: rows.length }), summary };
}

async function runTournament(paths: OpsPaths, job: QueueJob): Promise<{ resultId: string; summary: string }> {
  const specs = (job.spec.configs || []).map(file => toSpec(loadConfig(file), 'selfplay'));
  const rows = await tournament(specs, evenGames(job.spec.games ?? 2), 4000);
  const summary = rows.map(row => `${row.name} ${row.elo.toFixed(0)}`).join(', ') || 'empty tournament';
  return { resultId: writeResult(paths, job, summary, { players: rows.length }), summary };
}

async function runPositionReplay(paths: OpsPaths, job: QueueJob): Promise<{ resultId: string; summary: string }> {
  const positions = positionsFor(paths, job);
  const depth = Math.min(3, Math.max(2, (job.spec.labelDepth ?? positions[0]?.labelDepth ?? 1) + 1));
  let checked = 0;
  let disagreements = 0;
  for (const position of positions.slice(0, 4)) {
    const battle = battleFromInputLog(position.inputLog);
    const trace = exactSearch(battle, position.side, {
      depth,
      opponentModel: 'max-damage',
      evalMode: 'hp',
      errorAsLoss: false,
    });
    checked += 1;
    if (trace.choice !== position.label) disagreements += 1;
  }
  const summary = `depth ${depth} disagrees with the stored label on ${disagreements} of ${checked} positions`;
  return { resultId: writeResult(paths, job, summary, { depth, checked, disagreements }), summary };
}

function positionsFor(paths: OpsPaths, job: QueueJob): PositionRecord[] {
  const mined = readJsonl<PositionRecord>(paths.regressionSuite).filter(row => row.inputLog && row.label);
  const pool = [...mined, ...loadPool(paths.pool), ...loadPool()];
  if (job.spec.positionId) {
    const hit = pool.filter(position => position.id === job.spec.positionId);
    if (hit.length) return hit;
  }
  const critical = pool.filter(position => position.source === 'mined');
  return critical.length ? critical : pool.slice(0, 1);
}

function writeResult(paths: OpsPaths, job: QueueJob, summary: string, metrics: Record<string, unknown>): string {
  const db = openDb(paths);
  const id = resultId(job);
  const now = Date.now();
  try {
    db.addNode({
      id,
      type: 'Result',
      status: 'done',
      title: `factory ${job.spec.kind}`,
      description: summary,
      created_at: now,
      updated_at: now,
      metrics,
      metadata: { idempotencyKey: job.idempotencyKey, kind: job.spec.kind },
    });
    db.addEdge({
      id: `${job.id}-produced-${id}`,
      from_node: job.id,
      to_node: id,
      type: 'produced',
      created_at: now,
    });
  } finally {
    db.close();
  }
  return id;
}

function resultId(job: QueueJob): string {
  return `result-${job.idempotencyKey}`;
}

function evenGames(games: number): number {
  const count = Math.max(2, games);
  return count % 2 === 0 ? count : count + 1;
}
