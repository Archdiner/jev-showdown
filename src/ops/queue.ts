import { createHash } from 'crypto';
import { GraphDB } from '../graph/db.js';
import type { OpsPaths } from './paths.js';
import { openDb } from './db.js';
import { sprtMaxGames } from './sprt.js';
import type { SprtVerdict } from './sprt.js';

export const JOB_KINDS = ['challenger', 'sweep', 'tournament', 'ablation', 'position-replay'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export interface JobSpec {
  kind: JobKind;
  challenger?: string;
  opponent?: string;
  base?: string;
  configs?: string[];
  games?: number;
  axes?: Array<{ path: string; values: Array<string | number | boolean> }>;
  positionId?: string;
  labelDepth?: number;
  /** Mechanism or eval term this challenger is testing. Same id, one job. */
  variantId?: string;
}

/** Running paired tally. `games` is the batch size on the spec; this is the sample so far. */
export interface SprtProgress {
  wins: number;
  losses: number;
  games: number;
  invalid: number;
  crashes: number;
  sprt: SprtVerdict;
  seed: number;
  configId?: string;
}

/** Factory evidence for a series that did not earn a live-approved proposal. */
export interface Handoff {
  configPath: string;
  configId: string;
  wins: number;
  losses: number;
  invalid: number;
  crashes: number;
  games: number;
  sprt: SprtVerdict;
  opponent: string;
}

export interface QueueJob {
  id: string;
  status: string;
  spec: JobSpec;
  idempotencyKey: string;
  leaseUntil?: number;
  proposal?: Proposal;
  resultId?: string;
  decisionId?: string;
  attempts?: number;
  progress?: SprtProgress;
  handoff?: Handoff;
}

export interface Proposal {
  action: 'champion' | 'live-approved';
  configPath: string;
  configId: string;
  summary: string;
}

export interface EnqueueResult {
  id: string;
  created: boolean;
  /** A finished SPRT-continue job was reopened. It is the same id, not a second job. */
  resumed?: boolean;
  /** The same spec already reached a terminal result. */
  finished?: boolean;
}

const LEASE_MS = 10 * 60 * 1000;

export function idempotencyKey(spec: JobSpec): string {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 16);
}

export function enqueue(paths: OpsPaths, spec: JobSpec, maxGames = sprtMaxGames()): EnqueueResult {
  const key = idempotencyKey(spec);
  const db = openDb(paths);
  try {
    const existing = findByKey(db, key);
    if (existing) return resumeOrSkip(db, existing, maxGames);
    const now = Date.now();
    const id = `ops-job-${key}`;
    db.addNode({
      id,
      type: 'Experiment',
      status: 'open',
      title: `ops ${spec.kind}`,
      description: spec.challenger || spec.base || spec.positionId || spec.kind,
      created_at: now,
      updated_at: now,
      config_path: spec.challenger || spec.base,
      metadata: { ops: { spec: { ...spec }, idempotencyKey: key } },
    });
    return { id, created: true };
  } finally {
    db.close();
  }
}

/** Done challengers that SPRT has not finished become open again. */
export function reopenContinuable(paths: OpsPaths, maxGames = sprtMaxGames()): number {
  const db = openDb(paths);
  try {
    let reopened = 0;
    for (const node of db.getNodesByType('Experiment', 'done')) {
      const ops = opsOf(node);
      if (!ops) continue;
      const metrics = resultMetrics(db, ops.resultId);
      if (!challengerCanContinue(ops, metrics, maxGames)) continue;
      const progress = normalizeProgress(ops.progress) ?? progressFromMetrics(metrics);
      db.updateNode(node.id, {
        status: 'open',
        metadata: {
          ...(node.metadata ?? {}),
          ops: { ...ops, ...(progress ? { progress } : {}), leaseUntil: 0 },
        },
      });
      reopened += 1;
    }
    return reopened;
  } finally {
    db.close();
  }
}

export function claimNext(paths: OpsPaths, maxGames = sprtMaxGames()): QueueJob | null {
  const db = openDb(paths);
  try {
    const now = Date.now();
    const jobs = [...db.getNodesByType('Experiment', 'open'), ...db.getNodesByType('Experiment', 'in_progress')];
    for (const node of jobs) {
      const ops = opsOf(node);
      if (!ops) continue;
      if (node.status === 'in_progress' && (ops.leaseUntil ?? 0) > now) continue;
      const metrics = resultMetrics(db, ops.resultId);
      if (ops.resultId && !challengerCanContinue(ops, metrics, maxGames)) {
        db.updateNode(node.id, { status: 'done' });
        continue;
      }
      const progress = normalizeProgress(ops.progress) ?? progressFromMetrics(metrics) ?? ops.progress;
      const leaseUntil = now + LEASE_MS;
      const nextOps = { ...ops, ...(progress ? { progress } : {}), leaseUntil, ownerPid: process.pid };
      db.updateNode(node.id, {
        status: 'in_progress',
        metadata: { ...(node.metadata ?? {}), ops: nextOps },
      });
      return toJob(node.id, 'in_progress', nextOps);
    }
    return null;
  } finally {
    db.close();
  }
}

export function completeJob(
  paths: OpsPaths,
  id: string,
  patch: {
    resultId?: string;
    proposal?: Proposal;
    decisionId?: string;
    attempts?: number;
    status?: 'done' | 'rejected' | 'open';
    progress?: SprtProgress;
    handoff?: Handoff;
  }
): void {
  const db = openDb(paths);
  try {
    const node = db.getNode(id);
    if (!node) return;
    const ops = opsOf(node) ?? { spec: { kind: 'challenger' as const }, idempotencyKey: id };
    db.updateNode(id, {
      status: patch.status ?? 'done',
      metadata: {
        ...(node.metadata ?? {}),
        ops: {
          ...ops,
          resultId: patch.resultId ?? ops.resultId,
          proposal: patch.proposal ?? ops.proposal,
          decisionId: patch.decisionId ?? ops.decisionId,
          attempts: patch.attempts ?? ops.attempts,
          progress: patch.progress ?? ops.progress,
          handoff: patch.handoff ?? ops.handoff,
          leaseUntil: 0,
        },
      },
    });
  } finally {
    db.close();
  }
}

export function listJobs(paths: OpsPaths): QueueJob[] {
  const db = openDb(paths);
  try {
    return db.getNodesByType('Experiment')
      .map(node => {
        const ops = opsOf(node);
        return ops ? toJob(node.id, node.status, ops) : null;
      })
      .filter((job): job is QueueJob => Boolean(job));
  } finally {
    db.close();
  }
}

export function listProposals(paths: OpsPaths): Array<QueueJob & { proposal: Proposal }> {
  return listJobs(paths).filter((job): job is QueueJob & { proposal: Proposal } => Boolean(job.proposal) && !job.decisionId);
}

export function listHandoffs(paths: OpsPaths): Array<QueueJob & { handoff: Handoff }> {
  return listJobs(paths).filter((job): job is QueueJob & { handoff: Handoff } => {
    return job.status === 'done' && Boolean(job.handoff) && !job.proposal && !job.decisionId;
  });
}

/**
 * A challenger whose last sample is still SPRT `continue`, under the budget,
 * with no gate decision and no live-approved proposal.
 */
export function challengerCanContinue(
  ops: { spec: JobSpec; decisionId?: string; proposal?: Proposal; progress?: SprtProgress },
  metrics: Record<string, unknown> | null | undefined,
  maxGames: number,
): boolean {
  if (ops.spec.kind !== 'challenger') return false;
  if (ops.decisionId || ops.proposal) return false;
  const progress = normalizeProgress(ops.progress) ?? progressFromMetrics(metrics);
  if (!progress || progress.sprt !== 'continue') return false;
  return progress.games < maxGames;
}

interface OpsMeta {
  spec: JobSpec;
  idempotencyKey: string;
  leaseUntil?: number;
  ownerPid?: number;
  proposal?: Proposal;
  resultId?: string;
  decisionId?: string;
  attempts?: number;
  progress?: SprtProgress;
  handoff?: Handoff;
}

function resumeOrSkip(db: GraphDB, existing: { id: string; status: string; ops: OpsMeta; metadata?: Record<string, unknown> }, maxGames: number): EnqueueResult {
  if (existing.status === 'open' || existing.status === 'in_progress') {
    return { id: existing.id, created: false };
  }
  const metrics = resultMetrics(db, existing.ops.resultId);
  if (challengerCanContinue(existing.ops, metrics, maxGames)) {
    const progress = normalizeProgress(existing.ops.progress) ?? progressFromMetrics(metrics);
    db.updateNode(existing.id, {
      status: 'open',
      metadata: {
        ...(existing.metadata ?? {}),
        ops: { ...existing.ops, ...(progress ? { progress } : {}), leaseUntil: 0 },
      },
    });
    return { id: existing.id, created: false, resumed: true };
  }
  return { id: existing.id, created: false, finished: true };
}

function opsOf(node: { metadata?: Record<string, unknown> }): OpsMeta | null {
  const ops = node.metadata?.ops as OpsMeta | undefined;
  if (!ops?.spec?.kind || !ops.idempotencyKey) return null;
  return ops;
}

function findByKey(db: GraphDB, key: string): { id: string; status: string; ops: OpsMeta; metadata?: Record<string, unknown> } | null {
  for (const node of db.getNodesByType('Experiment')) {
    const ops = opsOf(node);
    if (ops?.idempotencyKey === key) return { id: node.id, status: node.status, ops, metadata: node.metadata };
  }
  return null;
}

function resultMetrics(db: GraphDB, resultId: string | undefined): Record<string, unknown> | null {
  if (!resultId) return null;
  const node = db.getNode(resultId);
  const metrics = node?.metrics;
  return metrics && typeof metrics === 'object' ? metrics as Record<string, unknown> : null;
}

function progressFromMetrics(metrics: Record<string, unknown> | null | undefined): SprtProgress | null {
  if (!metrics || (metrics.sprt !== 'promote' && metrics.sprt !== 'reject' && metrics.sprt !== 'continue')) return null;
  const games = numberOf(metrics.games);
  const wins = numberOf(metrics.wins);
  const losses = typeof metrics.losses === 'number' && Number.isFinite(metrics.losses) ? metrics.losses : Math.max(0, games - wins);
  const seed = typeof metrics.seed === 'number' && Number.isFinite(metrics.seed) ? metrics.seed : 1000 + Math.floor(games / 2);
  return {
    wins,
    losses,
    games,
    invalid: numberOf(metrics.invalid),
    crashes: numberOf(metrics.crashes),
    sprt: metrics.sprt,
    seed,
    ...(typeof metrics.configId === 'string' ? { configId: metrics.configId } : {}),
  };
}

function normalizeProgress(progress: SprtProgress | undefined): SprtProgress | null {
  if (!progress || (progress.sprt !== 'promote' && progress.sprt !== 'reject' && progress.sprt !== 'continue')) return null;
  const games = numberOf(progress.games);
  const wins = numberOf(progress.wins);
  const losses = Number.isFinite(progress.losses) ? progress.losses : Math.max(0, games - wins);
  const seed = Number.isFinite(progress.seed) ? progress.seed : 1000 + Math.floor(games / 2);
  return { ...progress, wins, losses, games, seed };
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toJob(id: string, status: string, ops: OpsMeta): QueueJob {
  return {
    id,
    status,
    spec: ops.spec,
    idempotencyKey: ops.idempotencyKey,
    leaseUntil: ops.leaseUntil,
    proposal: ops.proposal,
    resultId: ops.resultId,
    decisionId: ops.decisionId,
    attempts: ops.attempts,
    progress: ops.progress,
    handoff: ops.handoff,
  };
}
