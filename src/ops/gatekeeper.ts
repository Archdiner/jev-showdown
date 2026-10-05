import { createHash } from 'crypto';
import { loadConfig, toSpec, type LoadedConfig } from '../config/load.js';
import type { BotSpec } from '../config/interfaces.js';
import type { GameResult } from '../bench/game.js';
import { runDiagnosticSuite } from '../engine/exact/diagnostics.js';
import type { ExactConfig } from '../engine/exact/search.js';
import { playPaired } from '../exp/play.js';
import { recordPromoted, recordRejected } from './cycle.js';
import { openDb } from './db.js';
import { beat } from './heartbeat.js';
import { writeChampion, writeLiveApproved } from './labels.js';
import type { OpsPaths } from './paths.js';
import { listProposals, completeJob, type Proposal } from './queue.js';
import { sprt, tallySide } from './sprt.js';

export { sprt } from './sprt.js';

const EXACT_SEARCHES = new Set(['greedy-1ply', 'depth-n', 'expectimax', 'mcts-stub']);
const DEFAULT_MAX_GAMES = 1200;
const DEFAULT_BATCH = 50;

export interface DiagnosticReport {
  passed: number;
  failed: number;
  total: number;
}

export interface Evidence {
  configPath: string;
  action: 'champion' | 'live-approved';
  wins: number;
  losses: number;
  invalid: number;
  crashes: number;
  diagnostics: DiagnosticReport;
  /** Present when the caller is the no-game bootstrap path. It does not skip SPRT. */
  bootstrap?: boolean;
}

export interface Verdict {
  labeled: boolean;
  reason: string;
  decisionId: string;
  sprt: 'promote' | 'reject' | 'continue';
}

/** Search settings the diagnostic suite should run. A non-exact config does not inherit the champion suite. */
export function exactDiagnosticsConfig(loaded: LoadedConfig): ExactConfig | null {
  if (!EXACT_SEARCHES.has(loaded.config.search.id)) return null;
  const params = loaded.config.search.params;
  return {
    depth: params.depth,
    samples: params.samples,
    opponentModel: params.opponentModel,
    evalMode: params.evalMode,
    errorAsLoss: false,
  };
}

export function diagnosticsForConfig(loaded: LoadedConfig): DiagnosticReport {
  const config = exactDiagnosticsConfig(loaded);
  if (!config) return { passed: 0, failed: 1, total: 1 };
  const result = runDiagnosticSuite(config);
  return { passed: result.passed, failed: result.failed, total: result.total };
}

export function realDiagnostics(configPath = 'configs/champion.yaml'): DiagnosticReport {
  return diagnosticsForConfig(loadConfig(configPath));
}

/** Records a decision and writes a label only when the checks pass. */
export function judge(paths: OpsPaths, evidence: Evidence): Verdict {
  const diagnosticsPass = evidence.diagnostics.total > 0 && evidence.diagnostics.failed === 0;
  const guardrailsPass = evidence.invalid === 0 && evidence.crashes === 0;
  const sprtVerdict = sprt(evidence.wins, evidence.losses);
  const played = evidence.wins + evidence.losses;
  let labeled = false;
  let reason: string;
  if (!diagnosticsPass) {
    reason = `diagnostics ${evidence.diagnostics.passed}/${evidence.diagnostics.total}, need 100%`;
  } else if (!guardrailsPass) {
    reason = `guardrails failed: invalid=${evidence.invalid} crashes=${evidence.crashes}`;
  } else if (played === 0) {
    reason = `no paired games against the champion; diagnostics ${evidence.diagnostics.passed}/${evidence.diagnostics.total}`;
  } else if (sprtVerdict === 'reject') {
    reason = 'SPRT says the challenger is worse than the champion';
  } else if (sprtVerdict === 'continue') {
    reason = 'SPRT inconclusive, no label';
  } else {
    labeled = true;
    reason = `SPRT better than the champion and diagnostics ${evidence.diagnostics.passed}/${evidence.diagnostics.total}`;
  }

  const db = openDb(paths);
  const decisionId = `decision-${createHash('sha256').update(`${evidence.configPath}|${reason}|${Date.now()}`).digest('hex').slice(0, 12)}`;
  const now = Date.now();
  try {
    db.addNode({
      id: decisionId,
      type: 'Decision',
      status: labeled ? 'done' : 'rejected',
      title: labeled ? evidence.action : 'rejected',
      description: reason,
      created_at: now,
      updated_at: now,
      context: `${evidence.action} ${evidence.configPath}`,
      decision: labeled ? evidence.action : 'rejected',
      consequences: reason,
      metadata: {
        opsKind: 'gate',
        evidence,
        sprt: sprtVerdict,
      },
    });
    if (labeled && evidence.action === 'champion') writeChampion(db, evidence.configPath);
    if (labeled && evidence.action === 'live-approved') writeLiveApproved(db, evidence.configPath);
    if (labeled) recordPromoted(paths, reason);
    else if (sprtVerdict === 'reject' && played > 0) recordRejected(paths, reason);
    if (!labeled && sprtVerdict === 'reject') {
      db.addNode({
        id: `regression-${decisionId}`,
        type: 'Learning',
        status: 'detected',
        title: 'Open regression',
        description: reason,
        created_at: now,
        updated_at: now,
        insight: reason,
        evidence: evidence.configPath,
        confidence: 'medium',
        metadata: { opsKind: 'regression', configPath: evidence.configPath },
      });
    }
  } finally {
    db.close();
  }
  return { labeled, reason, decisionId, sprt: sprtVerdict };
}

export function bootstrapChampion(
  paths: OpsPaths,
  configPath = 'configs/champion.yaml',
  diagnostics: () => DiagnosticReport = realDiagnostics
): Verdict {
  return judge(paths, {
    configPath,
    action: 'champion',
    wins: 0,
    losses: 0,
    invalid: 0,
    crashes: 0,
    diagnostics: diagnostics(),
    bootstrap: true,
  });
}

export interface ReviewOptions {
  /** Upper bound on paired games. The default is large enough for a true +10 Elo to finish. */
  maxGames?: number;
  /** @deprecated Alias of maxGames. A short cap can only return "continue". */
  pairs?: number;
  batch?: number;
  opponentPath?: string;
  diagnostics?: (loaded: LoadedConfig) => DiagnosticReport;
  play?: (
    a: BotSpec,
    b: BotSpec,
    games: number,
    seed: number,
    parallel: boolean,
  ) => Promise<GameResult[]>;
}

export async function reviewProposals(paths: OpsPaths, opts: ReviewOptions = {}): Promise<Verdict[]> {
  const jobs = listProposals(paths);
  if (jobs.length === 0) return [];
  const diagnostics = opts.diagnostics ?? diagnosticsForConfig;
  const play = opts.play ?? playPaired;
  const maxGames = opts.maxGames ?? opts.pairs ?? DEFAULT_MAX_GAMES;
  const batch = opts.batch ?? DEFAULT_BATCH;
  const verdicts: Verdict[] = [];
  for (const job of jobs) {
    const proposal: Proposal = job.proposal;
    const loaded = loadConfig(proposal.configPath);
    const opponent = loadConfig(opts.opponentPath ?? 'configs/champion.yaml');
    const report = diagnostics(loaded);
    let wins = 0;
    let losses = 0;
    let invalid = 0;
    let crashes = 0;
    let played = 0;
    let seed = 9000;
    while (played < maxGames && sprt(wins, losses) === 'continue') {
      let games = Math.min(batch, maxGames - played);
      if (games < 2) break;
      if (games % 2 !== 0) games -= 1;
      const results = await play(toSpec(loaded, 'gate'), toSpec(opponent, 'gate'), games, seed, false);
      seed += games;
      if (results.length === 0) break;
      const tally = tallySide(results.map(game => ({
        winner: game.winner,
        p1Id: game.p1ConfigId,
        p2Id: game.p2ConfigId,
        p1Invalid: game.p1Invalid,
        p2Invalid: game.p2Invalid,
        crashed: game.crashed,
      })), loaded.configId);
      wins += tally.wins;
      losses += tally.losses;
      invalid += tally.invalid;
      crashes += tally.crashes;
      played += results.length;
    }
    const verdict = judge(paths, {
      configPath: proposal.configPath,
      action: proposal.action,
      wins,
      losses,
      invalid,
      crashes,
      diagnostics: report,
    });
    completeJob(paths, job.id, { decisionId: verdict.decisionId, status: 'done' });
    verdicts.push(verdict);
  }
  return verdicts;
}

export async function runGatekeeper(
  paths: OpsPaths,
  opts: { once?: boolean; pairs?: number; bootstrap?: boolean; diagnostics?: () => DiagnosticReport } = {}
): Promise<void> {
  beat(paths, 'gatekeeper', 'ok', 'up');
  do {
    if (opts.bootstrap) {
      const verdict = bootstrapChampion(paths, 'configs/champion.yaml', opts.diagnostics);
      beat(paths, 'gatekeeper', 'ok', verdict.reason);
    }
    const verdicts = await reviewProposals(paths, { pairs: opts.pairs, diagnostics: opts.diagnostics });
    beat(paths, 'gatekeeper', 'ok', verdicts.length ? verdicts.map(item => item.reason).join('; ') : 'idle');
    if (opts.once) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  } while (!opts.once);
  beat(paths, 'gatekeeper', 'stopped', 'exit');
}

