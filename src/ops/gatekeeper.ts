import { createHash } from 'crypto';
import { loadConfig, toSpec } from '../config/load.js';
import { runDiagnosticSuite } from '../engine/exact/diagnostics.js';
import { playPaired, sideWinRate } from '../exp/play.js';
import { openDb } from './db.js';
import { beat } from './heartbeat.js';
import { writeChampion, writeLiveApproved } from './labels.js';
import type { OpsPaths } from './paths.js';
import { listProposals, completeJob, type Proposal } from './queue.js';

const P0 = 0.5;
const P1 = 1 / (1 + 10 ** (-10 / 400));
const BOUNDARY = Math.log((1 - 0.05) / 0.05);

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
  /** Bootstrap labels the current champion file. It still requires 100% diagnostics. */
  bootstrap?: boolean;
}

export interface Verdict {
  labeled: boolean;
  reason: string;
  decisionId: string;
  sprt: 'promote' | 'reject' | 'continue';
}

export function sprt(wins: number, losses: number): Verdict['sprt'] {
  if (wins + losses === 0) return 'continue';
  const llr = wins * Math.log(P1 / P0) + losses * Math.log((1 - P1) / (1 - P0));
  if (llr >= BOUNDARY) return 'promote';
  if (llr <= -BOUNDARY) return 'reject';
  return 'continue';
}

export function realDiagnostics(): DiagnosticReport {
  const result = runDiagnosticSuite();
  return { passed: result.passed, failed: result.failed, total: result.total };
}

/** Records a decision and writes a label only when the checks pass. */
export function judge(paths: OpsPaths, evidence: Evidence): Verdict {
  const diagnosticsPass = evidence.diagnostics.total > 0 && evidence.diagnostics.failed === 0;
  const guardrailsPass = evidence.invalid === 0 && evidence.crashes === 0;
  const sprtVerdict = evidence.bootstrap ? 'continue' : sprt(evidence.wins, evidence.losses);
  let labeled = false;
  let reason: string;
  if (!diagnosticsPass) {
    reason = `diagnostics ${evidence.diagnostics.passed}/${evidence.diagnostics.total}, need 100%`;
  } else if (!guardrailsPass) {
    reason = `guardrails failed: invalid=${evidence.invalid} crashes=${evidence.crashes}`;
  } else if (evidence.bootstrap) {
    labeled = true;
    reason = `bootstrap ${evidence.configPath}; diagnostics ${evidence.diagnostics.passed}/${evidence.diagnostics.total}`;
  } else if (sprtVerdict === 'reject') {
    reason = 'SPRT says the challenger is worse than even';
  } else if (sprtVerdict === 'continue') {
    reason = 'SPRT inconclusive, no label';
  } else {
    labeled = true;
    reason = `SPRT no-regression and diagnostics ${evidence.diagnostics.passed}/${evidence.diagnostics.total}`;
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

export async function reviewProposals(
  paths: OpsPaths,
  opts: { pairs?: number; diagnostics?: () => DiagnosticReport } = {}
): Promise<Verdict[]> {
  const jobs = listProposals(paths);
  if (jobs.length === 0) return [];
  const diagnostics = opts.diagnostics ?? realDiagnostics;
  const report = diagnostics();
  const verdicts: Verdict[] = [];
  for (const job of jobs) {
    const proposal: Proposal = job.proposal;
    const loaded = loadConfig(proposal.configPath);
    const opponent = loadConfig(job.spec.opponent || 'configs/panel/maxdamage.yaml');
    const games = evenGames(opts.pairs ?? 150);
    const results = await playPaired(toSpec(loaded, 'gate'), toSpec(opponent, 'gate'), games, 9000, false);
    const rate = sideWinRate(results, loaded.configId);
    const wins = rate.wins;
    const losses = rate.games - rate.wins;
    const invalid = results.reduce((sum, game) => sum + game.p1Invalid + game.p2Invalid, 0);
    const verdict = judge(paths, {
      configPath: proposal.configPath,
      action: proposal.action,
      wins,
      losses,
      invalid,
      crashes: 0,
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

function evenGames(games: number): number {
  const count = Math.max(2, games);
  return count % 2 === 0 ? count : count + 1;
}
