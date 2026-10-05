/** Reliability severities. P0 is losing games or corrupting data right now. */
export type Severity = 'P0' | 'P1' | 'P2' | 'P3';

export type IncidentStatus = 'open' | 'acknowledged' | 'fixing' | 'resolved' | 'verified';

export const SEVERITY_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export const DEFAULTS = {
  soakMs: 10 * 60 * 1000,
  staleMs: 60 * 1000,
  drainPendingMs: 10 * 60 * 1000,
  speciesMin: 500,
  eloDropGames: 10,
  eloDrop: 40,
  /** Ladder remote decision budget. The gate's self-play guardrail is a separate 2s p99. */
  latencyBudgetMs: 12_000,
  winTarget: 0.5,
  /** A full batch pages only when it sits at least this far under the target. */
  winMargin: 0.1,
  batchSize: 10,
  lookbackMs: 24 * 60 * 60 * 1000,
  intervalMs: 60_000,
} as const;

export interface Evidence {
  file: string;
  line?: number;
  detail: string;
}

export interface CheckHit {
  key: string;
  detail: string;
  evidence: Evidence[];
}

export interface InvariantCheck {
  id: string;
  severity: Severity;
  title: string;
  suggestedFix: string;
  detect(ctx: SentinelContext): CheckHit[];
}

export interface ProcessSnapshot {
  pid: number;
  cmd: string;
  /** Undefined when the environment could not be read. An empty object was readable. */
  env?: Record<string, string>;
}

export interface GitStatus {
  /** Null when origin/main could not be compared. */
  behind: number | null;
  ref: string;
  detail: string;
}

export interface Layout {
  cwd: string;
  opsDir: string;
  ladderLogDir: string;
  liveRunsDir: string;
  dataDir: string;
  graphDb: string;
}

export interface LogRow {
  file: string;
  line: number;
  value: Record<string, unknown> | null;
  error?: string;
}

export interface DrainFile {
  path: string;
  mtimeMs: number;
}

export interface RunMeta {
  path: string;
  mtimeMs: number;
  runId: string;
  pid: number;
  username?: string;
  local?: boolean;
  engine?: string;
}

export interface ObservedGame {
  file: string;
  line: number;
  battleId: string;
  ts: number | null;
  turns: number | null;
  outcome: 'win' | 'loss' | 'tie' | null;
  endReason: string | null;
  eloBefore: number | null;
  eloAfter: number | null;
  invalid: number;
  /** Reasons from `invalidChoiceReasons` when that field is present. Empty when the field is absent. */
  invalidChoiceReasons: string[];
  crashes: number;
  fallbacks: number;
  minTimerMarginSec: number | null;
  replayUrl: string | null;
  replayStatus: string | null;
  local: boolean;
  ladder: boolean;
  gitSha: string | null;
  variantId: string | null;
  configId: string | null;
  username: string | null;
  format: string | null;
  schema: string | null;
  decisions: number | null;
  latencyP95Ms: number | null;
  phantom: boolean;
  source: string | null;
}

export interface SentinelContext {
  now: number;
  layout: Layout;
  lookbackMs: number;
  staleMs: number;
  drainPendingMs: number;
  speciesMin: number;
  eloDropGames: number;
  eloDrop: number;
  latencyBudgetMs: number;
  winTarget: number;
  winMargin: number;
  batchSize: number;
  processesScanned: boolean;
  processes: ProcessSnapshot[];
  git: GitStatus;
  rows: LogRow[];
  games: ObservedGame[];
  heartbeats: Array<Record<string, unknown> & { file: string; line: number }>;
  circuits: Record<string, { pulled?: boolean; reason?: string }> | null;
  circuitsPath: string;
  speciesCount: number | null;
  speciesPath: string;
  speciesError: string | null;
  drains: DrainFile[];
  runs: RunMeta[];
  summaryMtimeMs: number | null;
  decisionSamples: Array<{ file: string; line: number; ms: number }>;
}

export interface Incident {
  id: string;
  checkId: string;
  key: string;
  severity: Severity;
  title: string;
  suggestedFix: string | null;
  detail: string;
  firstSeen: number;
  lastSeen: number;
  count: number;
  evidence: Evidence[];
  status: IncidentStatus;
  rootCause: string | null;
  pr: string | null;
  episodeOpenedAt: number;
  clearSince: number | null;
  resolvedAt: number | null;
  verifiedAt: number | null;
}

export interface IncidentEvent {
  ts: number;
  type: 'opened' | 'updated' | 'acknowledged' | 'fixing' | 'resolved' | 'verified' | 'reopened' | 'root-cause';
  incidentId: string;
  checkId: string;
  key: string;
  severity: Severity;
  title: string;
  status: IncidentStatus;
  detail?: string;
  evidence?: Evidence[];
  count?: number;
  rootCause?: string | null;
  pr?: string | null;
  suggestedFix?: string | null;
  episodeOpenedAt?: number;
  clearSince?: number | null;
}

export function actionable(status: IncidentStatus): boolean {
  return status === 'open' || status === 'acknowledged' || status === 'fixing';
}
