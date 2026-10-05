import { createHash } from 'crypto';
import { GraphDB } from '../graph/db.js';
import type { OpsPaths } from './paths.js';
import { openDb } from './db.js';

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
}

export interface Proposal {
  action: 'champion' | 'live-approved';
  configPath: string;
  configId: string;
  summary: string;
}

const LEASE_MS = 10 * 60 * 1000;

export function idempotencyKey(spec: JobSpec): string {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 16);
}

export function enqueue(paths: OpsPaths, spec: JobSpec): { id: string; created: boolean } {
  const key = idempotencyKey(spec);
  const db = openDb(paths);
  try {
    const existing = findByKey(db, key);
    if (existing) return { id: existing.id, created: false };
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

export function claimNext(paths: OpsPaths): QueueJob | null {
  const db = openDb(paths);
  try {
    const now = Date.now();
    const jobs = [...db.getNodesByType('Experiment', 'open'), ...db.getNodesByType('Experiment', 'in_progress')];
    for (const node of jobs) {
      const ops = opsOf(node);
      if (!ops) continue;
      if (node.status === 'in_progress' && (ops.leaseUntil ?? 0) > now) continue;
      if (ops.resultId) {
        db.updateNode(node.id, { status: 'done' });
        continue;
      }
      const leaseUntil = now + LEASE_MS;
      db.updateNode(node.id, {
        status: 'in_progress',
        metadata: { ...(node.metadata ?? {}), ops: { ...ops, leaseUntil, ownerPid: process.pid } },
      });
      return toJob(node.id, 'in_progress', { ...ops, leaseUntil });
    }
    return null;
  } finally {
    db.close();
  }
}

export function completeJob(
  paths: OpsPaths,
  id: string,
  patch: { resultId?: string; proposal?: Proposal; decisionId?: string; attempts?: number; status?: 'done' | 'rejected' | 'open' }
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

interface OpsMeta {
  spec: JobSpec;
  idempotencyKey: string;
  leaseUntil?: number;
  ownerPid?: number;
  proposal?: Proposal;
  resultId?: string;
  decisionId?: string;
  attempts?: number;
}

function opsOf(node: { metadata?: Record<string, unknown> }): OpsMeta | null {
  const ops = node.metadata?.ops as OpsMeta | undefined;
  if (!ops?.spec?.kind || !ops.idempotencyKey) return null;
  return ops;
}

function findByKey(db: GraphDB, key: string): { id: string } | null {
  for (const node of db.getNodesByType('Experiment')) {
    if (opsOf(node)?.idempotencyKey === key) return { id: node.id };
  }
  return null;
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
  };
}
