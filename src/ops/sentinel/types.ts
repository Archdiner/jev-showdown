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
  /** Later live games that pass a per-game check before that episode resolves. */
  episodePassGames: 10,
  /** Live play after the latest failure that also resolves the episode. */
  episodePassMs: 30 * 60 * 1000,
  /** Append-only incident log rotates past this size. The snapshot keeps the state. */
  maxEventBytes: 1_048_576,
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
  /** Game time. Episode checks ignore hits older than the baseline. */
  at?: number | null;
  gitSha?: string | null;
  runId?: string | null;
  battleId?: string | null;
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
  ppid?: number;
  pgid?: number;
  /** `ps` lstart, in milliseconds, when it parsed. */
  startedAt?: number;
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
  /** Ladder runner checkout when it is not `cwd`. Null means the ops checkout is the only tree. */
  liveRepoDir: string | null;
  opsDir: string;
  ladderLogDir: string;
  liveRunsDir: string;
  dataDir: string;
  graphDb: string;
}

export interface CheckoutStatus {
  role: 'ops' | 'live';
  dir: string;
  git: GitStatus;
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
  checkout: 'ops' | 'live';
}

export interface LockSnapshot {
  path: string;
  checkout: 'ops' | 'live';
  dir: string;
  pid: number | null;
  username: string | null;
  startedAt: string | null;
  host: string | null;
}

/**
 * A batch that died on the old wall-clock reject, or that ended `stalled` / `timeout`.
 * Game-level end reasons (`ko`, `our-timer`) are not batch ends.
 */
export interface BatchEndSignal {
  file: string;
  line?: number;
  /** `stalled` and `timeout` are batch ends. `undrained-timeout` is the reject path that did not drain. */
  endReason: 'stalled' | 'timeout' | 'undrained-timeout';
  detail: string;
}

export interface RunMeta {
  path: string;
  mtimeMs: number;
  runId: string;
  pid: number;
  username?: string;
  local?: boolean;
  engine?: string;
  /** When the runner started. File mtime is the fallback. */
  startedAt?: number;
  gitSha?: string | null;
}

export interface RunSummary {
  games: number;
  wins: number | null;
  gitSha: string | null;
  requested: number | null;
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
  runId: string | null;
  batchLabel: string | null;
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
  /** True when `pid` is alive. Injected in tests. Production uses `process.kill(pid, 0)` after the process list. */
  pidAlive: (pid: number) => boolean;
  /** Null means every game in the lookback is in the evaluation baseline. */
  baselineMs: number | null;
  git: GitStatus;
  checkouts: CheckoutStatus[];
  rows: LogRow[];
  games: ObservedGame[];
  heartbeats: Array<Record<string, unknown> & { file: string; line: number }>;
  circuits: Record<string, { pulled?: boolean; reason?: string }> | null;
  circuitsPath: string;
  speciesCount: number | null;
  speciesPath: string;
  speciesError: string | null;
  drains: DrainFile[];
  locks: LockSnapshot[];
  runs: RunMeta[];
  runSummary: RunSummary | null;
  summaryMtimeMs: number | null;
  /** Batch-level stall or undrained timeout signals inside the lookback. No process list required. */
  batchEnds: BatchEndSignal[];
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
  /** External ledger id, for example INC-007. */
  ref: string | null;
  gitSha: string | null;
  runId: string | null;
  /** False when every failure on this episode is older than the baseline. */
  inBaseline: boolean;
  /** Battle ids that failed this episode. Empty for live-state checks. */
  battles: string[];
  lastFailureTs: number | null;
  episodeOpenedAt: number;
  clearSince: number | null;
  resolvedAt: number | null;
  verifiedAt: number | null;
}

export interface IncidentEvent {
  ts: number;
  type: 'opened' | 'updated' | 'acknowledged' | 'fixing' | 'resolved' | 'verified' | 'reopened' | 'root-cause' | 'linked';
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
  ref?: string | null;
  gitSha?: string | null;
  runId?: string | null;
  inBaseline?: boolean;
  battles?: string[];
  lastFailureTs?: number | null;
}

export function actionable(status: IncidentStatus): boolean {
  return status === 'open' || status === 'acknowledged' || status === 'fixing';
}
