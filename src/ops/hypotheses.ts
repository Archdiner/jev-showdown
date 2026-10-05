import * as fs from 'fs';
import * as path from 'path';
import { stringify } from 'yaml';
import { loadConfig } from '../config/load.js';
import { EVAL_TERMS } from '../config/schema.js';
import type { GraphDB } from '../graph/db.js';
import { appendJsonl, type OpsPaths } from './paths.js';
import { enqueue } from './queue.js';
import { recordSeed } from './cycle.js';

const EVAL_IDS = new Set<string>(EVAL_TERMS);
const CHAMPION = path.resolve(process.cwd(), 'configs/champion.yaml');
const MAX_DAMAGE = path.resolve(process.cwd(), 'configs/panel/maxdamage.yaml');

const POLICY_BY_MECHANISM: Record<string, string> = {
  'tera-timing': 'teraPolicy',
  'hazard-control': 'hazardPolicy',
  'switch-timing': 'switchPolicy',
  endgame: 'endgamePolicy',
  sac: 'sacPolicy',
  setup: 'leadPolicy',
};

const KEYWORDS: Array<{ id: string; pattern: RegExp }> = [
  { id: 'tera-timing', pattern: /\bteras?\b|terastall/i },
  { id: 'prediction', pattern: /opponent[- ]switch|switch probability|\bprior\b|opponent model/i },
  { id: 'hazard-control', pattern: /\bhazards?\b/i },
  { id: 'sac', pattern: /\bsack/i },
  { id: 'endgame', pattern: /\bendgame\b/i },
  { id: 'switch-timing', pattern: /\bswitch/i },
  { id: 'preservation', pattern: /\bpreserv|win[- ]?con/i },
  { id: 'speed-control', pattern: /\bspeed\b|outspeed/i },
  { id: 'setup', pattern: /\bsetup\b|\bboost/i },
  { id: 'hpDifference', pattern: /\bdamage\b|\bhp\b/i },
];

export interface HypothesisSource {
  id: string;
  title: string;
  description?: string;
  rationale?: string;
  metadata?: Record<string, unknown>;
}

export interface VariantQueueResult {
  created: boolean;
  resumed?: boolean;
  jobId?: string;
  variantId?: string;
  reason: string;
}

/**
 * A loss review names a mechanism or an eval term (`eval-term: preservation`).
 * A hypotheses.json row names the same kind of change in prose. The id is the
 * general knob the factory can self-play. Species and moves are not matched.
 */
export function variantFor(text: string): string | null {
  const named = /eval-term:\s*([A-Za-z]+)/.exec(text);
  if (named) return EVAL_IDS.has(named[1]) ? named[1] : null;
  const mechanism = /mechanism:\s*([a-z0-9-]+)/.exec(text);
  if (mechanism) {
    if (mechanism[1] === 'information') return null;
    if (mechanism[1] === 'speed-control' || mechanism[1] in POLICY_BY_MECHANISM || mechanism[1] === 'prediction') {
      return mechanism[1];
    }
    if (EVAL_IDS.has(mechanism[1])) return mechanism[1];
    return null;
  }
  for (const row of KEYWORDS) {
    if (row.pattern.test(text)) return row.id;
  }
  return null;
}

export function hypothesisGames(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OPS_HYPOTHESIS_GAMES);
  if (!Number.isFinite(raw) || raw < 2) return 4;
  const games = Math.floor(raw);
  return games % 2 === 0 ? games : games + 1;
}

/**
 * Turn one hypothesis into a challenger that differs from the champion by one
 * mechanism or eval term. The same variant is one job. `games` on that job is
 * one SPRT batch, not the budget. A copy of an open job is skipped. A finished
 * job that SPRT still calls `continue` is resumed. A terminal job is finished.
 */
export function queueHypothesisVariant(paths: OpsPaths, db: GraphDB, source: HypothesisSource): VariantQueueResult {
  const text = `${source.title}\n${source.description ?? ''}\n${source.rationale ?? ''}`;
  const variantId = variantFor(text);
  const meta = { ...(source.metadata ?? {}) };
  if (!variantId) {
    const reason = `skipped: no self-play variant for hypothesis ${source.id}`;
    remember(db, source.id, meta, { status: 'blocked', skipReason: reason });
    return { created: false, reason };
  }
  let file: string;
  try {
    file = writeVariant(paths, variantId);
    loadConfig(file);
  } catch (error) {
    const reason = `skipped: variant ${variantId} config failed (${error instanceof Error ? error.message : String(error)})`;
    remember(db, source.id, meta, { status: 'blocked', skipReason: reason, variantId });
    return { created: false, variantId, reason };
  }
  const queued = enqueue(paths, {
    kind: 'challenger',
    challenger: file,
    opponent: MAX_DAMAGE,
    games: hypothesisGames(),
    variantId,
  });
  if (queued.resumed) {
    const reason = `resumed variant ${variantId} as ${queued.id}`;
    remember(db, source.id, meta, { status: 'in_progress', variantId, jobId: queued.id });
    return { created: false, resumed: true, jobId: queued.id, variantId, reason };
  }
  if (queued.finished) {
    const reason = `skipped: variant ${variantId} already finished as ${queued.id}`;
    remember(db, source.id, meta, { status: 'blocked', skipReason: reason, variantId, jobId: queued.id });
    return { created: false, jobId: queued.id, variantId, reason };
  }
  if (!queued.created) {
    const reason = `skipped: variant ${variantId} already queued as ${queued.id}`;
    remember(db, source.id, meta, { status: 'blocked', skipReason: reason, variantId, jobId: queued.id });
    return { created: false, jobId: queued.id, variantId, reason };
  }
  const reason = `queued variant ${variantId} as ${queued.id}`;
  remember(db, source.id, meta, { status: 'in_progress', variantId, jobId: queued.id });
  return { created: true, jobId: queued.id, variantId, reason };
}

/** Open hypotheses with no job yet, plus hypotheses.json rows, become factory jobs. */
export function enqueueOpenHypotheses(paths: OpsPaths, db: GraphDB, now = Date.now()): number {
  ensureFileHypotheses(db, paths);
  let queued = 0;
  for (const node of db.getNodesByType('Hypothesis', 'open')) {
    const meta = (node.metadata ?? {}) as Record<string, unknown>;
    if (meta.jobId || meta.skipReason) continue;
    const result = queueHypothesisVariant(paths, db, {
      id: node.id,
      title: node.title,
      description: node.description,
      rationale: 'rationale' in node && typeof node.rationale === 'string' ? node.rationale : undefined,
      metadata: meta,
    });
    appendJsonl(paths.dispositions, {
      ts: now,
      hypothesisId: node.id,
      action: result.created ? 'queued' : 'skipped',
      reason: result.reason,
      jobId: result.jobId ?? null,
      variantId: result.variantId ?? null,
    });
    if (result.created) queued += 1;
  }
  recordSeed(paths, queued, now);
  return queued;
}

function remember(
  db: GraphDB,
  id: string,
  meta: Record<string, unknown>,
  patch: { status: 'in_progress' | 'blocked'; skipReason?: string; variantId?: string; jobId?: string },
): void {
  const next: Record<string, unknown> = { ...meta };
  if (patch.skipReason) next.skipReason = patch.skipReason;
  if (patch.variantId) next.variantId = patch.variantId;
  if (patch.jobId) next.jobId = patch.jobId;
  db.updateNode(id, { status: patch.status, metadata: next });
}

function writeVariant(paths: OpsPaths, variantId: string): string {
  const dir = path.join(paths.root, 'challengers');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${variantId}.yaml`);
  const body = variantDocument(variantId);
  if (!body) throw new Error(`no config patch for ${variantId}`);
  fs.writeFileSync(file, stringify(body));
  return file;
}

function variantDocument(variantId: string): Record<string, unknown> | null {
  const term = variantId === 'speed-control' ? 'speedOption' : EVAL_IDS.has(variantId) ? variantId : null;
  if (term) {
    return {
      name: `variant-${variantId}`,
      extends: CHAMPION,
      evaluator: { id: 'weighted', params: { weights: { [term]: 1.5 } } },
    };
  }
  const policy = POLICY_BY_MECHANISM[variantId];
  if (policy) {
    return {
      name: `variant-${variantId}`,
      extends: CHAMPION,
      policies: { [policy]: { id: 'heuristic', params: { enabled: true } } },
    };
  }
  if (variantId === 'prediction') {
    return {
      name: 'variant-prediction',
      extends: CHAMPION,
      opponentModel: { behavior: { id: 'switch-prone', params: { switchWeight: 2.5 } } },
    };
  }
  return null;
}

function ensureFileHypotheses(db: GraphDB, paths: OpsPaths): void {
  for (const file of hypothesisFiles(paths)) {
    for (const row of readHypothesisFile(file)) {
      const id = `hyp-file-${row.id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)}`;
      if (db.getNode(id)) continue;
      const now = Date.now();
      db.addNode({
        id,
        type: 'Hypothesis',
        status: 'open',
        title: row.change,
        description: row.change,
        created_at: now,
        updated_at: now,
        rationale: row.change,
        expected_effect: row.expected || 'Paired win rate against the frozen panel.',
        test_plan: 'Self-play the mapped mechanism or eval term against max-damage. Do not add a species rule.',
        metadata: { source: 'hypotheses-file', fileId: row.id, file },
      });
    }
  }
}

function hypothesisFiles(paths: OpsPaths): string[] {
  const files = [paths.hypotheses];
  if (process.env.HYPOTHESES_FILE) files.push(process.env.HYPOTHESES_FILE);
  const standard = path.resolve(process.cwd(), 'state', 'ops');
  if (path.resolve(paths.root) === standard) {
    files.push(
      path.join(process.cwd(), 'state', 'meta', 'hypotheses.json'),
      path.join(process.cwd(), 'showdown-lab', 'meta', 'hypotheses.json'),
    );
  }
  return [...new Set(files.map(file => path.resolve(file)))];
}

interface FileHypothesis {
  id: string;
  change: string;
  expected: string;
}

function readHypothesisFile(file: string): FileHypothesis[] {
  if (!fs.existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rows: FileHypothesis[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const change = typeof record.change === 'string'
      ? record.change.trim()
      : typeof record.title === 'string'
        ? record.title.trim()
        : '';
    if (!id || !change) continue;
    const expected = typeof record.expected_effect === 'string'
      ? record.expected_effect
      : typeof record.expectedEffect === 'string'
        ? record.expectedEffect
        : typeof record.metric === 'string'
          ? record.metric
          : '';
    rows.push({ id, change, expected });
  }
  return rows;
}
