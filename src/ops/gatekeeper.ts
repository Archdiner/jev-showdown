import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, toSpec, type LoadedConfig } from '../config/load.js';
import type { BotSpec } from '../config/interfaces.js';
import type { GameResult } from '../bench/game.js';
import { runDiagnosticSuite } from '../engine/exact/diagnostics.js';
import { EXACT_1PLY_QW, QUICK_WIN_SEARCH_ID, type ExactConfig } from '../engine/exact/search.js';
import { playPaired } from '../exp/play.js';
import { recordPromoted, recordRejected } from './cycle.js';
import { openDb } from './db.js';
import { beat } from './heartbeat.js';
import { writeChampion, writeLiveApproved } from './labels.js';
import type { OpsPaths } from './paths.js';
import { listHandoffs, listProposals, completeJob, type Proposal } from './queue.js';
import { countableGameRows } from '../client/game-integrity.js';
import { readLabels } from './labels-read.js';
import { sprt, tallySide } from './sprt.js';

export { sprt } from './sprt.js';

/**
 * Ladder JSONL is not the paired sample the gatekeeper labels on.
 * Anything that folds those rows into a promotion tally has to drop
 * duplicate battle ids and contaminated results first.
 */
export function ladderGamesForGate<T extends object>(rows: readonly T[]): T[] {
  return countableGameRows(rows);
}

const EXACT_SEARCHES = new Set(['greedy-1ply', 'depth-n', 'expectimax', 'mcts-stub', QUICK_WIN_SEARCH_ID]);
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
  /** Set when the tally is against a panel opponent rather than the champion. */
  opponent?: string;
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
  const base = loaded.config.search.id === QUICK_WIN_SEARCH_ID ? EXACT_1PLY_QW : null;
  return {
    depth: params.depth,
    samples: params.samples,
    opponentModel: params.opponentModel === 'uniform' ? 'uniform' : 'max-damage',
    evalMode: params.evalMode,
    errorAsLoss: false,
    ...(base ? { tera: base.tera, progress: base.progress, foePrior: base.foePrior } : {}),
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
    reason = evidence.opponent
      ? `SPRT says the challenger is worse than ${evidence.opponent}`
      : 'SPRT says the challenger is worse than the champion';
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

/**
 * A factory handoff is a finished max-damage series that did not earn a
 * live-approved proposal. The gatekeeper records the decision. It does not
 * label a clean promote from that series; that path is `reviewProposals`.
 */
export function reviewHandoffs(
  paths: OpsPaths,
  opts: Pick<ReviewOptions, 'diagnostics'> = {},
): Verdict[] {
  const diagnostics = opts.diagnostics ?? diagnosticsForConfig;
  const verdicts: Verdict[] = [];
  for (const job of listHandoffs(paths)) {
    const handoff = job.handoff;
    if (handoff.sprt === 'promote' && handoff.invalid === 0 && handoff.crashes === 0) continue;
    const loaded = loadConfig(handoff.configPath);
    const verdict = judge(paths, {
      configPath: handoff.configPath,
      action: 'live-approved',
      wins: handoff.wins,
      losses: handoff.losses,
      invalid: handoff.invalid,
      crashes: handoff.crashes,
      diagnostics: diagnostics(loaded),
      opponent: handoff.opponent,
    });
    completeJob(paths, job.id, { decisionId: verdict.decisionId, status: 'done' });
    verdicts.push(verdict);
  }
  return verdicts;
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

/** Factory evidence the gatekeeper can label without replaying the games. */
export interface RecordedScreen {
  policyId: string;
  searchId?: string;
  evaluatorId?: string;
  configPath: string;
  action: 'live-approved';
  opponent: string;
  information: string;
  seed: number;
  samples: number;
  games: number;
  wins: number;
  losses: number;
  ties: number;
  invalid: number;
  crashes: number;
  viewMiss: number;
  p50ms?: number;
  p95ms?: number;
  p99ms?: number;
  maxMs?: number;
  wilson95: [number, number];
}

export function recordedEvidenceDir(cwd = process.cwd()): string {
  return path.join(cwd, 'state', 'ops', 'recorded');
}

/** Recorded screens live under the ops root (`OPS_DIR/recorded`), not a fixed cwd path. */
export function recordedDirFor(paths: OpsPaths): string {
  return path.join(paths.root, 'recorded');
}

/**
 * Reads `state/ops/recorded/*.json` and writes a Result, a finished Experiment
 * (proposal plus decisionId, so reviewProposals does not replay it), a Decision,
 * and a live-approved label. SPRT is stored as computed. A recorded screen may
 * be labeled for A/B while SPRT is still `continue`. It never writes champion.
 * A decision that already exists is not diagnosed again. `runGatekeeper` calls
 * this once per process so heartbeats do not re-record the same screens.
 */
export function ingestRecordedEvidence(
  paths: OpsPaths,
  opts: { dir?: string; diagnostics?: (loaded: LoadedConfig) => DiagnosticReport } = {},
): Verdict[] {
  const dir = opts.dir ?? recordedDirFor(paths);
  if (!fs.existsSync(dir)) return [];
  const diagnostics = opts.diagnostics ?? diagnosticsForConfig;
  const verdicts: Verdict[] = [];
  for (const name of fs.readdirSync(dir).filter(file => file.endsWith('.json')).sort()) {
    const screen = readRecordedScreen(path.join(dir, name));
    if (!screen) continue;
    verdicts.push(recordScreen(paths, screen, diagnostics));
  }
  return verdicts;
}

function recordScreen(
  paths: OpsPaths,
  screen: RecordedScreen,
  diagnostics: (loaded: LoadedConfig) => DiagnosticReport,
): Verdict {
  const key = createHash('sha256').update(screen.configPath).digest('hex').slice(0, 12);
  const decisionId = `decision-recorded-${key}`;
  const db = openDb(paths);
  try {
    const existing = db.getNode(decisionId);
    if (existing?.type === 'Decision') {
      const labeled = existing.status === 'done' && existing.decision === 'live-approved';
      // Do not re-diagnose or re-emit the full screen score line. Heartbeats that
      // repeated "recorded screen 115-85…" every 2s looked like a re-record loop
      // (INC-043) and kept the hot path on the graph DB needlessly.
      if (labeled && !hasLiveApproval(db, screen.configPath)) writeLiveApproved(db, screen.configPath);
      return {
        labeled,
        reason: `already-recorded ${screen.configPath}`,
        decisionId,
        sprt: storedSprt(existing.metadata),
      };
    }
  } finally {
    db.close();
  }

  const loaded = loadConfig(screen.configPath);
  const report = diagnostics(loaded);
  const sprtVerdict = sprt(screen.wins, screen.losses);
  const diagnosticsPass = report.total > 0 && report.failed === 0;
  const guardrailsPass = screen.invalid === 0 && screen.crashes === 0 && (screen.viewMiss ?? 0) === 0;
  const counted = screen.wins + screen.losses + screen.ties === screen.games;
  const searchOk = !screen.searchId || loaded.config.search.id === screen.searchId;
  const evaluatorOk = !screen.evaluatorId || loaded.config.evaluator.id === screen.evaluatorId;
  const labeled = diagnosticsPass && guardrailsPass && counted && searchOk && evaluatorOk && screen.games > 0;
  const reason = labeled
    ? `recorded screen ${screen.wins}-${screen.losses}-${screen.ties} accepted for live A/B; SPRT ${sprtVerdict}; diagnostics ${report.passed}/${report.total}`
    : !searchOk
      ? `search id ${loaded.config.search.id} does not match recorded ${screen.searchId}`
      : !evaluatorOk
        ? `evaluator ${loaded.config.evaluator.id} does not match recorded ${screen.evaluatorId}`
        : !counted
        ? `recorded games ${screen.games} do not equal ${screen.wins}-${screen.losses}-${screen.ties}`
        : !diagnosticsPass
          ? `diagnostics ${report.passed}/${report.total}, need 100%`
          : `guardrails failed: invalid=${screen.invalid} crashes=${screen.crashes} viewMiss=${screen.viewMiss}`;

  const now = Date.now();
  const jobId = `ops-job-recorded-${key}`;
  const resultId = `result-recorded-${key}`;
  const hypothesisId = `hypothesis-recorded-${key}`;
  const proposal: Proposal = {
    action: 'live-approved',
    configPath: screen.configPath,
    configId: loaded.configId,
    summary: `${screen.wins}-${screen.losses}-${screen.ties} / ${screen.games}, SPRT ${sprtVerdict}`,
  };
  const writer = openDb(paths);
  try {
    writer.addNode({
      id: hypothesisId,
      type: 'Hypothesis',
      status: 'done',
      title: `${screen.policyId} recorded screen`,
      description: reason,
      created_at: now,
      updated_at: now,
      rationale: 'Owner-accepted hidden-info screen of this challenger against exact 1-ply.',
      expected_effect: 'A live A/B share, not a champion promotion.',
      test_plan: `${screen.games} ${screen.information} games, seed ${screen.seed}, ${screen.samples} samples, opponent ${screen.opponent}.`,
    });
    writer.addNode({
      id: resultId,
      type: 'Result',
      status: 'done',
      title: `factory challenger ${screen.policyId}`,
      description: `${screen.wins}/${screen.games} wins, invalid ${screen.invalid}`,
      created_at: now,
      updated_at: now,
      win_rate: screen.games > 0 ? screen.wins / screen.games : 0,
      game_count: screen.games,
      avg_latency_ms: screen.p99ms,
      confidence_interval: screen.wilson95,
      metrics: {
        wins: screen.wins,
        losses: screen.losses,
        ties: screen.ties,
        games: screen.games,
        invalid: screen.invalid,
        crashes: screen.crashes,
        viewMiss: screen.viewMiss,
        p50ms: screen.p50ms ?? null,
        p95ms: screen.p95ms ?? null,
        p99ms: screen.p99ms ?? null,
        maxMs: screen.maxMs ?? null,
        evaluatorId: screen.evaluatorId ?? null,
        wilson95: screen.wilson95,
        information: screen.information,
        seed: screen.seed,
        samples: screen.samples,
        opponent: screen.opponent,
        policyId: screen.policyId,
      },
      metadata: { idempotencyKey: key, kind: 'challenger', source: 'recorded-screen' },
    });
    writer.addNode({
      id: jobId,
      type: 'Experiment',
      status: 'done',
      title: `ops challenger ${screen.policyId}`,
      description: screen.configPath,
      created_at: now,
      updated_at: now,
      config_path: screen.configPath,
      hypothesis_id: hypothesisId,
      metadata: {
        ops: {
          spec: {
            kind: 'challenger',
            challenger: screen.configPath,
            games: screen.games,
            opponent: screen.opponent,
          },
          idempotencyKey: key,
          resultId,
          decisionId,
          proposal,
        },
      },
    });
    writer.addEdge({
      id: `${jobId}-produced-${resultId}`,
      from_node: jobId,
      to_node: resultId,
      type: 'produced',
      created_at: now,
    });
    writer.addNode({
      id: decisionId,
      type: 'Decision',
      status: labeled ? 'done' : 'rejected',
      title: labeled ? 'live-approved' : 'rejected',
      description: reason,
      created_at: now,
      updated_at: now,
      context: `live-approved ${screen.configPath}`,
      decision: labeled ? 'live-approved' : 'rejected',
      consequences: reason,
      metadata: {
        opsKind: 'gate',
        source: 'recorded-screen',
        sprt: sprtVerdict,
        evidence: {
          configPath: screen.configPath,
          action: 'live-approved',
          wins: screen.wins,
          losses: screen.losses,
          invalid: screen.invalid,
          crashes: screen.crashes,
          diagnostics: report,
          recorded: true,
          sprt: sprtVerdict,
          wilson95: screen.wilson95,
          p99ms: screen.p99ms ?? null,
          maxMs: screen.maxMs ?? null,
          games: screen.games,
          ties: screen.ties,
          viewMiss: screen.viewMiss,
          policyId: screen.policyId,
          opponent: screen.opponent,
          information: screen.information,
          seed: screen.seed,
          samples: screen.samples,
        },
      },
    });
    if (labeled) {
      writeLiveApproved(writer, screen.configPath);
      recordPromoted(paths, reason);
    }
  } finally {
    writer.close();
  }
  return { labeled, reason, decisionId, sprt: sprtVerdict };
}

function hasLiveApproval(db: ReturnType<typeof openDb>, configPath: string): boolean {
  return readLabels(db).some(item => item.configPath === configPath && item.labels.includes('live-approved'));
}

function storedSprt(metadata: Record<string, unknown> | undefined): Verdict['sprt'] {
  const value = metadata?.sprt;
  return value === 'promote' || value === 'reject' || value === 'continue' ? value : 'continue';
}

function readRecordedScreen(file: string): RecordedScreen | null {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.action !== 'live-approved') return null;
  if (typeof row.configPath !== 'string' || typeof row.policyId !== 'string') return null;
  if (typeof row.wins !== 'number' || typeof row.losses !== 'number' || typeof row.games !== 'number') return null;
  if (typeof row.invalid !== 'number' || typeof row.crashes !== 'number') return null;
  if (!Array.isArray(row.wilson95) || row.wilson95.length !== 2) return null;
  const low = Number(row.wilson95[0]);
  const high = Number(row.wilson95[1]);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  return {
    policyId: row.policyId,
    searchId: typeof row.searchId === 'string' ? row.searchId : undefined,
    evaluatorId: typeof row.evaluatorId === 'string' ? row.evaluatorId : undefined,
    configPath: row.configPath,
    action: 'live-approved',
    opponent: typeof row.opponent === 'string' ? row.opponent : 'EXACT_1PLY',
    information: typeof row.information === 'string' ? row.information : 'hidden',
    seed: typeof row.seed === 'number' ? row.seed : 1,
    samples: typeof row.samples === 'number' ? row.samples : 8,
    games: row.games,
    wins: row.wins,
    losses: row.losses,
    ties: typeof row.ties === 'number' ? row.ties : 0,
    invalid: row.invalid,
    crashes: row.crashes,
    viewMiss: typeof row.viewMiss === 'number' ? row.viewMiss : 0,
    p50ms: typeof row.p50ms === 'number' ? row.p50ms : undefined,
    p95ms: typeof row.p95ms === 'number' ? row.p95ms : undefined,
    p99ms: typeof row.p99ms === 'number' ? row.p99ms : undefined,
    maxMs: typeof row.maxMs === 'number' ? row.maxMs : undefined,
    wilson95: [low, high],
  };
}

export async function runGatekeeper(
  paths: OpsPaths,
  opts: {
    once?: boolean;
    pairs?: number;
    bootstrap?: boolean;
    diagnostics?: () => DiagnosticReport;
    /** Test seam: tick sleep. Production keeps 2000ms. */
    intervalMs?: number;
    /** Test seam: stop after N ticks when not `--once`. */
    maxTicks?: number;
  } = {}
): Promise<void> {
  beat(paths, 'gatekeeper', 'ok', 'up');
  const recordedDiagnostics = opts.diagnostics
    ? () => opts.diagnostics!()
    : undefined;
  // Recorded screens are owner-accepted evidence. Ingest once per process.
  // Re-reading them every 2s re-opened the graph, re-scanned labels, and when a
  // Decision was missing re-ran Diagnostics — the INC-043 hang pattern.
  let recordedIngested = false;
  let ticks = 0;
  do {
    ticks += 1;
    if (opts.bootstrap) {
      const verdict = bootstrapChampion(paths, 'configs/champion.yaml', opts.diagnostics);
      beat(paths, 'gatekeeper', 'ok', verdict.reason);
    }
    const recorded = recordedIngested
      ? []
      : ingestRecordedEvidence(paths, recordedDiagnostics ? { diagnostics: recordedDiagnostics } : {});
    recordedIngested = true;
    const handed = reviewHandoffs(paths, { diagnostics: opts.diagnostics });
    const verdicts = [
      ...recorded,
      ...handed,
      ...await reviewProposals(paths, { pairs: opts.pairs, diagnostics: opts.diagnostics }),
    ];
    beat(paths, 'gatekeeper', 'ok', verdicts.length ? verdicts.map(item => item.reason).join('; ') : 'idle');
    if (opts.once) break;
    if (opts.maxTicks != null && ticks >= opts.maxTicks) break;
    await new Promise(resolve => setTimeout(resolve, opts.intervalMs ?? 2000));
  } while (true);
  beat(paths, 'gatekeeper', 'stopped', 'exit');
}

