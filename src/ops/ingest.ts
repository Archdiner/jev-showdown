import * as fs from 'fs';
import * as path from 'path';
import { countableGameRows } from '../client/game-integrity.js';
import { isLocalLiveGame, isPhantomRecord } from '../client/game-record.js';
import { inputLogFromTranscript } from './sim-bridge.js';

export type Seat = 'p1' | 'p2';

export interface AnalystGame {
  id: string;
  outcome: 'win' | 'loss' | 'tie' | null;
  log: string;
  inputLog: string;
  configId?: string;
  username: string | null;
  ourSide: Seat | null;
  foeSide: Seat | null;
  sourcePath: string;
  battleId: string | null;
  endReason: string | null;
  turns: number | null;
  pid: number | null;
  ts: number | null;
  contaminated?: boolean;
  winner: string | null;
}

export function defaultAnalystDirs(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string[] {
  const ladder = env.LADDER_LOG_DIR || path.join(cwd, 'logs', 'ladder');
  const runs = env.LIVE_RUNS_DIR || path.join(cwd, 'live-runs');
  return [path.resolve(ladder), path.resolve(runs)];
}

/** Our seat from `|player|` lines. Null when the username is missing or not in the log. */
export function ourSideInLog(log: string, username: string | null | undefined): Seat | null {
  const want = normalizeName(username);
  if (!want) return null;
  for (const line of log.split('\n')) {
    if (!line.startsWith('|player|')) continue;
    const parts = line.split('|');
    const side = parts[2];
    if ((side === 'p1' || side === 'p2') && normalizeName(parts[3]) === want) return side;
  }
  return null;
}

export function foeOf(ourSide: Seat): Seat {
  return ourSide === 'p1' ? 'p2' : 'p1';
}

function normalizeName(value: string | null | undefined): string {
  return (value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** JSONL files under a ladder or live-runs directory. Metrics rows are not games. */
export function listGameJsonl(root: string): string[] {
  if (!root || !fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name !== 'metrics.jsonl') out.push(full);
    }
  };
  const stat = fs.statSync(root);
  if (stat.isDirectory()) walk(root);
  else if (root.endsWith('.jsonl') && path.basename(root) !== 'metrics.jsonl') out.push(root);
  return out.sort();
}

/** Read only complete lines past `offset`. A trailing partial line stays for the next tail. */
export function readCompleteChunk(file: string, offset: number): { text: string; next: number } {
  if (!fs.existsSync(file)) return { text: '', next: 0 };
  const size = fs.statSync(file).size;
  const start = offset > size ? 0 : Math.max(0, offset);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    const nl = text.lastIndexOf('\n');
    if (nl < 0) return { text: '', next: start };
    const slice = text.slice(0, nl + 1);
    return { text: slice, next: start + Buffer.byteLength(slice) };
  } finally {
    fs.closeSync(fd);
  }
}

export function gameFromRow(row: unknown, sourcePath: string): AnalystGame | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  if (isPhantomRecord(record)) return null;
  if (isLocalLiveGame({
    localServer: record.localServer === true,
    replayStatus: typeof record.replayStatus === 'string' ? record.replayStatus : null,
  })) return null;
  if (!isGameRecord(record)) return null;
  const id = gameId(record);
  if (!id) return null;
  const log = protocolOf(record);
  const username = typeof record.username === 'string' ? record.username : null;
  const explicit = record.ourSide === 'p1' || record.ourSide === 'p2' ? record.ourSide : null;
  const ourSide = explicit ?? ourSideInLog(log, username);
  const fieldLog = typeof record.inputLog === 'string' ? record.inputLog : '';
  const extracted = inputLogFromTranscript(log) || '';
  const inputLog = fieldLog.includes('>start') ? fieldLog : (extracted.includes('>start') ? extracted : fieldLog);
  const configId = typeof record.configId === 'string' ? record.configId : undefined;
  return {
    id,
    outcome: outcomeOf(record),
    log,
    inputLog,
    configId,
    username,
    ourSide,
    foeSide: ourSide ? foeOf(ourSide) : null,
    sourcePath,
    battleId: typeof record.battleId === 'string' ? record.battleId : null,
    endReason: typeof record.endReason === 'string' ? record.endReason : null,
    turns: typeof record.turns === 'number' ? record.turns : null,
    pid: typeof record.pid === 'number' ? record.pid : null,
    ts: typeof record.ts === 'number' ? record.ts : null,
    contaminated: record.contaminated === true,
    winner: typeof record.winner === 'string' ? record.winner : null,
  };
}

export function gamesInChunk(text: string, sourcePath: string): { games: AnalystGame[]; corrupt: number } {
  const games: AnalystGame[] = [];
  let corrupt = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      corrupt += 1;
      continue;
    }
    const game = gameFromRow(row, sourcePath);
    if (game) games.push(game);
  }
  return { games: countableGameRows(games), corrupt };
}

function isGameRecord(row: Record<string, unknown>): boolean {
  if (row.kind === 'ladder-game' || row.kind === 'live-game') return true;
  if (row.schema === 'jev.ladder-game.v1') return true;
  if (row.type === 'result' && (row.outcome || row.winner)) return true;
  if (typeof row.id === 'string' && row.id.trim() && (row.outcome || row.winner)) return true;
  return false;
}

function gameId(row: Record<string, unknown>): string | null {
  if (typeof row.id === 'string' && row.id.trim()) return row.id.trim();
  if (typeof row.battleId !== 'string' || !row.battleId.trim()) return null;
  return typeof row.ts === 'number' ? `${row.battleId}-${row.ts}` : row.battleId;
}

function outcomeOf(row: Record<string, unknown>): AnalystGame['outcome'] {
  const value = row.outcome ?? row.winner;
  return value === 'win' || value === 'loss' || value === 'tie' ? value : null;
}

function protocolOf(row: Record<string, unknown>): string {
  if (typeof row.log === 'string' && row.log.includes('|')) return row.log;
  const local = typeof row.localReplayPath === 'string' ? row.localReplayPath : '';
  if (local && fs.existsSync(local)) {
    try {
      return fs.readFileSync(local, 'utf8');
    } catch {
      return '';
    }
  }
  return typeof row.log === 'string' ? row.log : '';
}
