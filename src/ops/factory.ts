import { battleFromInputLog } from '../config/adapters.js';
import type { PositionRecord } from '../config/interfaces.js';
import { loadConfig, toSpec } from '../config/load.js';
import { loadPool } from '../config/positions.js';
import { exactSearch } from '../engine/exact/search.js';
import { ablate } from '../exp/ablate.js';
import { playPaired, sideWinRate } from '../exp/play.js';
import { liveProposalAllowed, tallySide } from './sprt.js';
import { sweep } from '../exp/sweep.js';
import { tournament } from '../exp/tournament.js';
import { openDb } from './db.js';
import { beat } from './heartbeat.js';
import type { OpsPaths } from './paths.js';
import { readJsonl } from './paths.js';
import { claimNext, completeJob, type Proposal, type QueueJob } from './queue.js';

/**
 * Runs queued experiments and may attach a proposal.
 * It does not write champion or live-approved labels.
 */
export async function runFactory(paths: OpsPaths, opts: { once?: boolean } = {}): Promise<number> {
  beat(paths, 'factory', 'ok', 'up');
  let ran = 0;
  do {
    const job = claimNext(paths);
    if (!job) {
      beat(paths, 'factory', 'ok', 'idle');
      if (opts.once) break;
      await new Promise(resolve => setTimeout(resolve, 2000));
      continue;
    }
    try {
      if (alreadyDone(paths, job)) {
        ran += 1;
        continue;
      }
      const outcome = await execute(paths, job);
      completeJob(paths, job.id, { resultId: outcome.resultId, proposal: outcome.proposal, status: 'done' });
      beat(paths, 'factory', 'ok', outcome.summary);
      ran += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempts = (job.attempts ?? 0) + 1;
      completeJob(paths, job.id, { status: attempts >= 3 ? 'rejected' : 'open', attempts });
      beat(paths, 'factory', 'error', message);
      if (opts.once) break;
    }
    if (opts.once) break;
  } while (!opts.once);
  beat(paths, 'factory', 'stopped', 'exit');
  return ran;
}

function alreadyDone(paths: OpsPaths, job: QueueJob): boolean {
  const db = openDb(paths);
  try {
    const id = resultId(job);
    if (!db.getNode(id)) return false;
    completeJob(paths, job.id, { resultId: id, status: 'done' });
    return true;
  } finally {
    db.close();
  }
}

async function execute(paths: OpsPaths, job: QueueJob): Promise<{ resultId: string; summary: string; proposal?: Proposal }> {
  if (job.spec.kind === 'challenger') return runChallenger(paths, job);
  if (job.spec.kind === 'sweep') return runSweep(paths, job);
  if (job.spec.kind === 'ablation') return runAblation(paths, job);
  if (job.spec.kind === 'tournament') return runTournament(paths, job);
  return runPositionReplay(paths, job);
}

async function runChallenger(paths: OpsPaths, job: QueueJob): Promise<{ resultId: string; summary: string; proposal?: Proposal }> {
  const challengerPath = job.spec.challenger || 'configs/champion.yaml';
  const challenger = loadConfig(challengerPath);
  const opponent = loadConfig(job.spec.opponent || 'configs/panel/maxdamage.yaml');
  const games = evenGames(job.spec.games ?? 4);
  const results = await playPaired(toSpec(challenger, 'selfplay'), toSpec(opponent, 'selfplay'), games, 1000, false);
  const rate = sideWinRate(results, challenger.configId);
  const tally = tallySide(results.map(game => ({
    winner: game.winner,
    p1Id: game.p1ConfigId,
    p2Id: game.p2ConfigId,
    p1Invalid: game.p1Invalid,
    p2Invalid: game.p2Invalid,
    crashed: game.crashed,
  })), challenger.configId);
  const summary = `${tally.wins}/${rate.games} wins, invalid ${tally.invalid}`;
  const proposal = liveProposalAllowed(tally.wins, tally.losses, tally.invalid)
    ? {
        action: 'live-approved' as const,
        configPath: challengerPath,
        configId: challenger.configId,
        summary,
      }
    : undefined;
  return { resultId: writeResult(paths, job, summary, { wins: tally.wins, games: results.length, invalid: tally.invalid }), summary, proposal };
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
