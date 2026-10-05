import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { pidAlive as processAlive } from '../../client/ladder-run.js';
import { observeGames } from './games.js';
import {
  DEFAULTS,
  type CheckoutStatus,
  type DrainFile,
  type GitStatus,
  type Layout,
  type LockSnapshot,
  type LogRow,
  type ProcessSnapshot,
  type RunMeta,
  type RunSummary,
  type SentinelContext,
} from './types.js';

export interface LoadOptions {
  now?: number;
  lookbackMs?: number;
  staleMs?: number;
  drainPendingMs?: number;
  speciesMin?: number;
  eloDropGames?: number;
  eloDrop?: number;
  latencyBudgetMs?: number;
  winTarget?: number;
  winMargin?: number;
  batchSize?: number;
  /**
   * False skips /proc. The process list is then empty and checks that need
   * live pids stay quiet. Tests pass `processes` with the default true.
   */
  scanProcesses?: boolean;
  /** When set, this list is the process snapshot and /proc is not read. */
  processes?: ProcessSnapshot[];
  /** When set, git is not invoked for the ops checkout. */
  git?: GitStatus;
  /** When set, git is not invoked for LIVE_REPO_DIR. */
  liveGit?: GitStatus;
  /**
   * Evaluation baseline in milliseconds. Undefined derives it from the newest
   * non-local run. Null disables the cutoff.
   */
  baselineMs?: number | null;
  /** When set, this replaces `process.kill(pid, 0)`. */
  pidAlive?: (pid: number) => boolean;
}

export function loadContext(layout: Layout, options: LoadOptions = {}): SentinelContext {
  const processesScanned = options.scanProcesses !== false;
  const processes = !processesScanned ? [] : (options.processes ?? scanProcesses());
  const pidAlive = options.pidAlive
    ?? (options.processes ? (pid: number) => options.processes?.some(proc => proc.pid === pid) ?? false : processAlive);
  const rows = collectRows(layout);
  const speciesPath = path.join(layout.dataDir, 'gen9-stats.json');
  const species = readSpecies(speciesPath);
  const runs = findRuns(layout.liveRunsDir);
  const now = options.now ?? Date.now();
  const opsGit = options.git ?? readGit(layout.cwd);
  const summaryPath = path.join(layout.ladderLogDir, 'summary.json');
  return {
    now,
    layout,
    lookbackMs: options.lookbackMs ?? DEFAULTS.lookbackMs,
    staleMs: options.staleMs ?? DEFAULTS.staleMs,
    drainPendingMs: options.drainPendingMs ?? DEFAULTS.drainPendingMs,
    speciesMin: options.speciesMin ?? DEFAULTS.speciesMin,
    eloDropGames: options.eloDropGames ?? DEFAULTS.eloDropGames,
    eloDrop: options.eloDrop ?? DEFAULTS.eloDrop,
    latencyBudgetMs: options.latencyBudgetMs ?? DEFAULTS.latencyBudgetMs,
    winTarget: options.winTarget ?? DEFAULTS.winTarget,
    winMargin: options.winMargin ?? DEFAULTS.winMargin,
    batchSize: options.batchSize ?? DEFAULTS.batchSize,
    processesScanned,
    processes,
    pidAlive,
    baselineMs: options.baselineMs === undefined ? defaultBaseline(runs) : options.baselineMs,
    git: opsGit,
    checkouts: readCheckouts(layout, opsGit, options.liveGit),
    rows,
    games: assignRuns(observeGames(rows), runs),
    heartbeats: heartbeatRows(rows),
    circuits: readCircuits(path.join(layout.opsDir, 'circuits.json')),
    circuitsPath: path.join(layout.opsDir, 'circuits.json'),
    speciesCount: species.count,
    speciesPath,
    speciesError: species.error,
    drains: findDrains(layout),
    locks: findLocks(layout),
    runs,
    runSummary: readSummary(summaryPath),
    summaryMtimeMs: mtimeIfExists(summaryPath),
    decisionSamples: decisionSamples(rows),
  };
}

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** Parse `ps -axo pid,ppid,pgid,lstart,command`. The header and short lines are skipped. */
export function parsePs(text: string): ProcessSnapshot[] {
  const out: ProcessSnapshot[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
    if (!match) continue;
    const cmd = match[5].trim();
    if (!cmd) continue;
    out.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      startedAt: parseLstart(match[4]),
      cmd,
    });
  }
  return out;
}

export function relevantProcess(cmd: string): boolean {
  return /src\/cli\/ladder\.ts|src\/ops\/cli\.ts|run-live\.sh/.test(cmd);
}

/**
 * Runner liveness is this `ps` list, or `kill -0` on a run-file pid.
 * `/proc` is not a liveness source. When it exists it only adds env to a pid `ps` already listed.
 */
export function scanProcesses(deps: { ps?: () => string; procRoot?: string } = {}): ProcessSnapshot[] {
  const procRoot = deps.procRoot ?? '/proc';
  let psRows: ProcessSnapshot[] = [];
  try {
    const text = deps.ps
      ? deps.ps()
      : execFileSync('ps', ['-axo', 'pid,ppid,pgid,lstart,command'], {
        encoding: 'utf8',
        timeout: 4000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    psRows = parsePs(text).filter(row => relevantProcess(row.cmd));
  } catch {
    psRows = [];
  }
  if (psRows.length === 0) return [];
  const envByPid = new Map(readProc(procRoot).map(row => [row.pid, row.env]));
  return psRows.map(row => {
    const env = envByPid.get(row.pid);
    return env ? { ...row, env } : row;
  });
}

/** Git root of `dir`, or null when `dir` is missing or not inside a work tree. */
export function gitTopLevel(dir: string): string | null {
  if (!dir || !fs.existsSync(dir)) return null;
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function readGit(cwd: string): GitStatus {
  try {
    const out = execFileSync('git', ['rev-list', '--count', 'HEAD..origin/main'], {
      cwd,
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const behind = Number(out);
    if (!Number.isFinite(behind)) {
      return { behind: null, ref: 'origin/main', detail: 'git rev-list did not return a count' };
    }
    const detail = behind === 0
      ? 'HEAD contains origin/main'
      : `HEAD is ${behind} commit${behind === 1 ? '' : 's'} behind origin/main`;
    return { behind, ref: 'origin/main', detail };
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : 'git failed';
    return { behind: null, ref: 'origin/main', detail: message };
  }
}

export function readLogFile(file: string): LogRow[] {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const rows: LogRow[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        rows.push({ file, line: index + 1, value: null, error: 'JSON value is not an object' });
      } else {
        rows.push({ file, line: index + 1, value: parsed as Record<string, unknown> });
      }
    } catch (err) {
      rows.push({
        file,
        line: index + 1,
        value: null,
        error: err instanceof Error ? err.message : 'invalid JSON',
      });
    }
  }
  return rows;
}

function collectRows(layout: Layout): LogRow[] {
  const files = new Set<string>();
  for (const dir of [layout.ladderLogDir, layout.liveRunsDir, layout.opsDir]) addJsonl(dir, files);
  const decisions = path.join(layout.cwd, 'state', 'decisions.jsonl');
  if (fs.existsSync(decisions)) files.add(decisions);
  const rows: LogRow[] = [];
  for (const file of [...files].sort()) rows.push(...readLogFile(file));
  return rows;
}

function addJsonl(dir: string, into: Set<string>): void {
  if (!dir || !fs.existsSync(dir)) return;
  const stat = fs.statSync(dir);
  if (stat.isFile()) {
    if (dir.endsWith('.jsonl')) into.add(dir);
    return;
  }
  const walk = (current: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) into.add(full);
    }
  };
  walk(dir);
}

function heartbeatRows(rows: LogRow[]): SentinelContext['heartbeats'] {
  const out: SentinelContext['heartbeats'] = [];
  for (const row of rows) {
    const value = row.value;
    if (!value || typeof value.facility !== 'string' || typeof value.ts !== 'number') continue;
    if (value.status !== 'ok' && value.status !== 'error' && value.status !== 'stopped') continue;
    out.push({ ...value, file: row.file, line: row.line });
  }
  return out;
}

function decisionSamples(rows: LogRow[]): SentinelContext['decisionSamples'] {
  const samples: SentinelContext['decisionSamples'] = [];
  for (const row of rows) {
    const value = row.value;
    if (!value) continue;
    const kind = value.kind ?? value.type;
    if (kind !== 'decision') continue;
    const ms = typeof value.latencyMs === 'number' ? value.latencyMs : typeof value.ms === 'number' ? value.ms : null;
    if (ms === null || !Number.isFinite(ms)) continue;
    samples.push({ file: row.file, line: row.line, ms });
  }
  return samples;
}

function readCircuits(file: string): SentinelContext['circuits'] {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as SentinelContext['circuits'];
  } catch {
    return {};
  }
}

function readSpecies(file: string): { count: number | null; error: string | null } {
  if (!fs.existsSync(file)) return { count: null, error: 'file is missing' };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { count: null, error: 'file is not a species map' };
    }
    return { count: Object.keys(parsed).length, error: null };
  } catch (err) {
    return { count: null, error: err instanceof Error ? err.message : 'unreadable' };
  }
}

function findDrains(layout: Layout): DrainFile[] {
  const found = new Map<string, DrainFile>();
  const add = (file: string, checkout: 'ops' | 'live') => {
    const when = mtimeIfExists(file);
    if (when === null) return;
    found.set(path.resolve(file), { path: file, mtimeMs: when, checkout });
  };
  add(path.join(layout.cwd, 'state', 'DRAIN'), 'ops');
  if (layout.liveRepoDir && path.resolve(layout.liveRepoDir) !== path.resolve(layout.cwd)) {
    add(path.join(layout.liveRepoDir, 'state', 'DRAIN'), 'live');
    const liveRuns = path.join(layout.liveRepoDir, 'live-runs');
    if (path.resolve(liveRuns) !== path.resolve(layout.liveRunsDir) && fs.existsSync(liveRuns)) {
      for (const name of fs.readdirSync(liveRuns)) {
        if (name.endsWith('.drain')) add(path.join(liveRuns, name), 'live');
      }
    }
  }
  const runsCheckout = layout.liveRepoDir && path.resolve(layout.liveRunsDir).startsWith(path.resolve(layout.liveRepoDir))
    ? 'live'
    : 'ops';
  if (fs.existsSync(layout.liveRunsDir)) {
    for (const name of fs.readdirSync(layout.liveRunsDir)) {
      if (name.endsWith('.drain')) add(path.join(layout.liveRunsDir, name), runsCheckout);
    }
  }
  return [...found.values()];
}

function findLocks(layout: Layout): LockSnapshot[] {
  const locks: LockSnapshot[] = [];
  const seen = new Set<string>();
  const addDir = (dir: string, checkout: 'ops' | 'live') => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith('ladder-') || !name.endsWith('.lock')) continue;
      const file = path.join(dir, name);
      const resolved = path.resolve(file);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      locks.push(readLock(file, checkout, dir));
    }
  };
  addDir(path.join(layout.cwd, 'state'), 'ops');
  if (layout.liveRepoDir && path.resolve(layout.liveRepoDir) !== path.resolve(layout.cwd)) {
    addDir(path.join(layout.liveRepoDir, 'state'), 'live');
  }
  return locks;
}

function readLock(file: string, checkout: 'ops' | 'live', dir: string): LockSnapshot {
  let parsed: Record<string, unknown> = {};
  try {
    const body = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (body && typeof body === 'object' && !Array.isArray(body)) parsed = body as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return {
    path: file,
    checkout,
    dir,
    pid: typeof parsed.pid === 'number' ? parsed.pid : null,
    username: typeof parsed.username === 'string' ? parsed.username : null,
    startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
    host: typeof parsed.host === 'string' ? parsed.host : null,
  };
}

function findRuns(dir: string): RunMeta[] {
  if (!fs.existsSync(dir)) return [];
  const runs: RunMeta[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof parsed.pid !== 'number') continue;
    runs.push({
      path: file,
      mtimeMs: mtimeIfExists(file) ?? 0,
      runId: typeof parsed.runId === 'string' ? parsed.runId : name.replace(/\.json$/, ''),
      pid: parsed.pid,
      username: typeof parsed.username === 'string' ? parsed.username : undefined,
      local: parsed.local === true,
      engine: typeof parsed.engine === 'string' ? parsed.engine : undefined,
      startedAt: startedAtOf(parsed.startedAt),
      gitSha: typeof parsed.gitSha === 'string' ? parsed.gitSha : null,
    });
  }
  return runs;
}

function startedAtOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function defaultBaseline(runs: RunMeta[]): number | null {
  const live = runs.filter(run => !run.local);
  if (live.length === 0) return null;
  const newest = live.reduce((best, run) => runStart(run) >= runStart(best) ? run : best);
  return runStart(newest);
}

function runStart(run: RunMeta): number {
  return run.startedAt ?? run.mtimeMs;
}

function assignRuns(games: SentinelContext['games'], runs: RunMeta[]): SentinelContext['games'] {
  const live = runs.filter(run => !run.local).sort((a, b) => runStart(a) - runStart(b));
  return games.map(game => {
    if (game.runId) return game;
    if (game.ts === null || live.length === 0) return game;
    let match: RunMeta | null = null;
    for (const run of live) {
      if (runStart(run) <= game.ts) match = run;
    }
    if (!match) return game;
    return { ...game, runId: match.runId, gitSha: game.gitSha ?? match.gitSha ?? null };
  });
}

function readCheckouts(layout: Layout, opsGit: GitStatus, liveGit: GitStatus | undefined): CheckoutStatus[] {
  const checkouts: CheckoutStatus[] = [{ role: 'ops', dir: layout.cwd, git: opsGit }];
  if (!layout.liveRepoDir) return checkouts;
  if (path.resolve(layout.liveRepoDir) === path.resolve(layout.cwd)) return checkouts;
  checkouts.push({
    role: 'live',
    dir: layout.liveRepoDir,
    git: liveGit ?? readGit(layout.liveRepoDir),
  });
  return checkouts;
}

function readSummary(file: string): RunSummary | null {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.games !== 'number') return null;
    return {
      games: parsed.games,
      wins: typeof parsed.wins === 'number' ? parsed.wins : null,
      gitSha: typeof parsed.gitSha === 'string' ? parsed.gitSha : null,
      requested: typeof parsed.requested === 'number' ? parsed.requested : null,
    };
  } catch {
    return null;
  }
}

function readProc(root: string): ProcessSnapshot[] {
  if (!fs.existsSync(root)) return [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: ProcessSnapshot[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let cmd = '';
    try {
      cmd = fs.readFileSync(path.join(root, name, 'cmdline'), 'utf8').replace(/\0/g, ' ').trim();
    } catch {
      continue;
    }
    if (!cmd || !relevantProcess(cmd)) continue;
    let env: Record<string, string> | undefined;
    try {
      env = parseEnviron(fs.readFileSync(path.join(root, name, 'environ')));
    } catch {
      env = undefined;
    }
    out.push({ pid, cmd, env });
  }
  return out;
}

function parseLstart(text: string): number | undefined {
  const match = /^(\w{3})\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text.trim());
  if (!match) return undefined;
  const month = MONTHS[match[2]];
  if (month === undefined) return undefined;
  return Date.UTC(Number(match[7]), month, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
}

function mtimeIfExists(file: string): number | null {
  if (!fs.existsSync(file)) return null;
  return fs.statSync(file).mtimeMs;
}

function parseEnviron(buf: Buffer): Record<string, string> {
  const env: Record<string, string> = {};
  for (const part of buf.toString('utf8').split('\0')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    env[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return env;
}
