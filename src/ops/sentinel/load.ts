import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { GraphDB } from '../../graph/db.js';
import { readLabels } from '../labels-read.js';
import { observeGames } from './games.js';
import {
  DEFAULTS,
  type BatchEndSignal,
  type DrainFile,
  type GitStatus,
  type Layout,
  type LogRow,
  type ProcessSnapshot,
  type RunMeta,
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
   * False skips the process list. Checks that need live pids stay quiet.
   * Tests pass `processes` with the default true.
   */
  scanProcesses?: boolean;
  /** When set, this list is the process snapshot. /proc and ps are not read. */
  processes?: ProcessSnapshot[];
  /** When set, git is not invoked. */
  git?: GitStatus;
}

export function loadContext(layout: Layout, options: LoadOptions = {}): SentinelContext {
  const now = options.now ?? Date.now();
  const lookbackMs = options.lookbackMs ?? DEFAULTS.lookbackMs;
  const snapshot = options.scanProcesses === false
    ? { processes: [] as ProcessSnapshot[], scanned: false }
    : options.processes
      ? { processes: options.processes, scanned: true }
      : snapshotProcesses({ procRoot: '/proc' });
  const processesScanned = snapshot.scanned;
  const processes = snapshot.processes;
  const rows = collectRows(layout);
  const speciesPath = path.join(layout.dataDir, 'gen9-stats.json');
  const species = readSpecies(speciesPath);
  return {
    now,
    layout,
    lookbackMs,
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
    git: options.git ?? readGit(layout.cwd),
    rows,
    games: observeGames(rows),
    heartbeats: heartbeatRows(rows),
    circuits: readCircuits(path.join(layout.opsDir, 'circuits.json')),
    approvedConfigIds: approvedConfigIds(layout.graphDb),
    circuitsPath: path.join(layout.opsDir, 'circuits.json'),
    speciesCount: species.count,
    speciesPath,
    speciesError: species.error,
    drains: findDrains(layout),
    runs: findRuns(layout.liveRunsDir),
    summaryMtimeMs: mtimeIfExists(path.join(layout.ladderLogDir, 'summary.json')),
    batchEnds: collectBatchEnds(layout, rows, now, lookbackMs),
    decisionSamples: decisionSamples(rows),
  };
}

const LADDER_CMD = /src\/cli\/ladder\.ts|src\/ops\/cli\.ts|run-live\.sh/;
const TIMED_OUT_LINE = /Timed out after (\d+)\/(\d+) games/;
const STALLED_LINE = /stalled after (\d+)\/(\d+) games/;

export interface ProcessScanInput {
  /** Directory shaped like /proc. Missing on macOS. */
  procRoot?: string;
  /** Process table text. Used when `procRoot` does not exist. */
  readTable?: () => string;
}

/**
 * Linux reads /proc. macOS has no /proc, so the same snapshot comes from `ps`.
 * A failed listing is `scanned: false` so a dead process list is not treated as
 * every runner having exited.
 */
export function snapshotProcesses(input: ProcessScanInput = {}): { processes: ProcessSnapshot[]; scanned: boolean } {
  const root = input.procRoot ?? '/proc';
  if (fs.existsSync(root)) return { processes: scanProc(root), scanned: true };
  const readTable = input.readTable ?? readProcessTable;
  try {
    return { processes: parseProcessTable(readTable()), scanned: true };
  } catch {
    return { processes: [], scanned: false };
  }
}

export function scanProcesses(input: ProcessScanInput = {}): ProcessSnapshot[] {
  return snapshotProcesses(input).processes;
}

/** `ps -axww -o pid=,command=` rows. Works on macOS and Linux. */
export function parseProcessTable(text: string): ProcessSnapshot[] {
  const out: ProcessSnapshot[] = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.*\S)\s*$/);
    if (!match) continue;
    const cmd = match[2].trim();
    if (!LADDER_CMD.test(cmd)) continue;
    out.push({ pid: Number(match[1]), cmd });
  }
  return out;
}

function scanProc(root: string): ProcessSnapshot[] {
  const out: ProcessSnapshot[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let cmd = '';
    try {
      cmd = fs.readFileSync(path.join(root, name, 'cmdline'), 'utf8').replace(/\0/g, ' ').trim();
    } catch {
      continue;
    }
    if (!cmd || !LADDER_CMD.test(cmd)) continue;
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

function readProcessTable(): string {
  return execFileSync('ps', ['-axww', '-o', 'pid=,command='], {
    encoding: 'utf8',
    timeout: 8000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function collectBatchEnds(layout: Layout, rows: LogRow[], now: number, lookbackMs: number): BatchEndSignal[] {
  const signals: BatchEndSignal[] = [];
  const summaryPath = path.join(layout.ladderLogDir, 'summary.json');
  const summary = readSummaryEnd(summaryPath, now, lookbackMs);
  if (summary) signals.push(summary);
  for (const row of rows) {
    const signal = runRowEnd(row, now, lookbackMs);
    if (signal) signals.push(signal);
  }
  for (const file of listLogFiles(layout.ladderLogDir).concat(listLogFiles(layout.liveRunsDir))) {
    signals.push(...readLogEnds(file, now, lookbackMs));
  }
  return signals;
}

function readSummaryEnd(file: string, now: number, lookbackMs: number): BatchEndSignal | null {
  const when = mtimeIfExists(file);
  if (when === null || now - when > lookbackMs || when > now + 60_000) return null;
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const reason = batchReason(parsed.endReason);
  if (!reason) return null;
  const games = typeof parsed.games === 'number' ? parsed.games : '?';
  const requested = typeof parsed.requested === 'number' ? parsed.requested : '?';
  return {
    file,
    endReason: reason,
    detail: `summary endReason=${reason} games=${games}/${requested}`,
  };
}

function runRowEnd(row: LogRow, now: number, lookbackMs: number): BatchEndSignal | null {
  const value = row.value;
  if (!value) return null;
  const type = value.type ?? value.kind;
  if (type !== 'run' && type !== 'ladder-batch') return null;
  const ts = typeof value.ts === 'number' ? value.ts : null;
  if (ts !== null && (ts < now - lookbackMs || ts > now + 60_000)) return null;
  const reason = batchReason(value.endReason);
  if (!reason) return null;
  const games = typeof value.games === 'number' ? value.games : '?';
  const requested = typeof value.requested === 'number' ? value.requested : '?';
  return {
    file: row.file,
    line: row.line,
    endReason: reason,
    detail: `${String(type)} endReason=${reason} games=${games}/${requested}`,
  };
}

function batchReason(value: unknown): 'stalled' | 'timeout' | null {
  if (value === 'stalled' || value === 'timeout') return value;
  return null;
}

function readLogEnds(file: string, now: number, lookbackMs: number): BatchEndSignal[] {
  const when = mtimeIfExists(file);
  if (when === null || now - when > lookbackMs || when > now + 60_000) return [];
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const signals: BatchEndSignal[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const timedOut = line.match(TIMED_OUT_LINE);
    if (timedOut) {
      signals.push({
        file,
        line: index + 1,
        endReason: 'undrained-timeout',
        detail: `Timed out after ${timedOut[1]}/${timedOut[2]} games with no drain`,
      });
    }
    const stalled = line.match(STALLED_LINE);
    if (stalled) {
      signals.push({
        file,
        line: index + 1,
        endReason: 'stalled',
        detail: `stalled after ${stalled[1]}/${stalled[2]} games`,
      });
    }
  }
  return signals;
}

function listLogFiles(dir: string): string[] {
  if (!dir || !fs.existsSync(dir)) return [];
  const found: string[] = [];
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
      else if (entry.isFile() && entry.name.endsWith('.log')) found.push(full);
    }
  };
  try {
    const stat = fs.statSync(dir);
    if (stat.isFile()) return dir.endsWith('.log') ? [dir] : [];
  } catch {
    return [];
  }
  walk(dir);
  return found;
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

function approvedConfigIds(graphDb: string): string[] | null {
  if (!fs.existsSync(graphDb)) return null;
  try {
    const db = new GraphDB(graphDb);
    try {
      return readLabels(db).map(label => label.configId);
    } finally {
      db.close();
    }
  } catch {
    return null;
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
  const add = (file: string) => {
    const when = mtimeIfExists(file);
    if (when === null) return;
    found.set(path.resolve(file), { path: file, mtimeMs: when });
  };
  add(path.join(layout.cwd, 'state', 'DRAIN'));
  if (fs.existsSync(layout.liveRunsDir)) {
    for (const name of fs.readdirSync(layout.liveRunsDir)) {
      if (name.endsWith('.drain')) add(path.join(layout.liveRunsDir, name));
    }
  }
  return [...found.values()];
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
    });
  }
  return runs;
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
