import * as fs from 'fs';
import * as path from 'path';
import { isPhantomRecord } from './game-record.js';

/**
 * Sidecar next to a game log. Repair and the recorder append flags here.
 * `games.jsonl` itself is never rewritten or truncated.
 */
export const CONTAMINATION_FILE = 'games.contamination.jsonl';
export const CONTAMINATION_SCHEMA = 'jev.game-contamination.v1' as const;

export type ContaminationReason = 'non-owning-process' | 'conflicting-result';

export interface ContaminationFlag {
  schema: typeof CONTAMINATION_SCHEMA;
  battleId: string;
  pid: number | null;
  ts: number | null;
  reason: ContaminationReason;
  /** Readers skip a game row this flag matches. */
  exclude: boolean;
  note: string;
}

export const REQUIRED_GAME_FIELDS = [
  'minTimerMarginSec',
  'eloAfter',
  'opponentRating',
  'endReason',
  'durationMs',
  'configId',
  'gitSha',
  'replayUrl',
] as const;

export type RequiredGameField = (typeof REQUIRED_GAME_FIELDS)[number];

export interface InvariantFinding {
  code: 'duplicate-battle-id' | 'null-replay-url' | 'null-required-field';
  battleId: string | null;
  field?: string;
  detail: string;
}

interface RowView {
  battleId?: unknown;
  id?: unknown;
  kind?: unknown;
  schema?: unknown;
  type?: unknown;
  pid?: unknown;
  ts?: unknown;
  startedAt?: unknown;
  outcome?: unknown;
  winner?: unknown;
  endReason?: unknown;
  turns?: unknown;
  contaminated?: unknown;
  phantom?: unknown;
}

function view(row: object): RowView {
  return row as RowView;
}

function hasResult(row: RowView): boolean {
  return row.outcome === 'win' || row.outcome === 'loss' || row.outcome === 'tie'
    || row.winner === 'win' || row.winner === 'loss' || row.winner === 'tie';
}

export function isLadderGameRow(row: object): boolean {
  const record = view(row);
  if (record.kind === 'contamination') return false;
  if (record.kind === 'ladder-game' || record.kind === 'live-game') return true;
  if (record.schema === 'jev.ladder-game.v1') return true;
  if (record.type === 'result' && (record.outcome || record.winner)) return true;
  if (record.type === 'game' && (record.outcome || record.winner)) return true;
  // gameFromRow drops kind and schema. The projection still has sourcePath and a result.
  if (typeof (row as { sourcePath?: unknown }).sourcePath === 'string' && hasResult(record)) return true;
  return false;
}

/** Room id. A `live-game` row stores it on `id` when `battleId` is absent. */
export function battleIdOf(row: object): string | null {
  const record = view(row);
  if (typeof record.battleId === 'string' && record.battleId.trim()) return record.battleId.trim();
  if (
    (record.kind === 'live-game' || record.kind === 'ladder-game' || record.schema === 'jev.ladder-game.v1')
    && typeof record.id === 'string'
    && record.id.startsWith('battle-')
  ) {
    return record.id.trim();
  }
  return null;
}

function outcomeOf(row: RowView): string | null {
  if (row.outcome === 'win' || row.outcome === 'loss' || row.outcome === 'tie') return row.outcome;
  if (row.winner === 'win' || row.winner === 'loss' || row.winner === 'tie') return row.winner;
  return null;
}

function resultKey(row: RowView): string {
  return `${outcomeOf(row) ?? ''}|${typeof row.endReason === 'string' ? row.endReason : ''}|${typeof row.winner === 'string' ? row.winner : ''}`;
}

/** A second process's dropped socket: turns already played, no winner, disconnect or unknown. */
export function isDuplicateDisconnect(row: object): boolean {
  const record = view(row);
  const turns = typeof record.turns === 'number' ? record.turns : 0;
  if (turns <= 0) return false;
  if (outcomeOf(record) !== 'tie') return false;
  return record.endReason === 'disconnect' || record.endReason === 'unknown' || record.endReason == null;
}

function pidOf(row: RowView): number | null {
  return typeof row.pid === 'number' && Number.isFinite(row.pid) ? row.pid : null;
}

function tsOf(row: RowView): number | null {
  return typeof row.ts === 'number' && Number.isFinite(row.ts) ? row.ts : null;
}

function stamp(row: RowView): number {
  if (typeof row.startedAt === 'number' && Number.isFinite(row.startedAt)) return row.startedAt;
  if (typeof row.ts === 'number' && Number.isFinite(row.ts)) return row.ts;
  return Number.POSITIVE_INFINITY;
}

function flagFor(row: object, reason: ContaminationReason, note: string): ContaminationFlag {
  const record = view(row);
  return {
    schema: CONTAMINATION_SCHEMA,
    battleId: battleIdOf(row) ?? '',
    pid: pidOf(record),
    ts: tsOf(record),
    reason,
    exclude: true,
    note,
  };
}

/**
 * Which physical rows to drop. Agreeing duplicates are not flagged; readers
 * keep one. A disconnect tie beside a decisive result is the non-owning
 * process. Two decisive results exclude the whole battle.
 */
export function contaminationFlagsFor(rows: readonly object[]): ContaminationFlag[] {
  const groups = new Map<string, object[]>();
  for (const row of rows) {
    if (!isLadderGameRow(row) || isPhantomRecord(view(row))) continue;
    if (view(row).contaminated === true) continue;
    const id = battleIdOf(row);
    if (!id) continue;
    const group = groups.get(id) ?? [];
    group.push(row);
    groups.set(id, group);
  }

  const flags: ContaminationFlag[] = [];
  for (const [battleId, group] of groups) {
    if (group.length < 2) continue;
    const disconnects = group.filter(row => isDuplicateDisconnect(row));
    const rest = group.filter(row => !isDuplicateDisconnect(row));
    const restKeys = new Set(rest.map(row => resultKey(view(row))));
    if (disconnects.length > 0 && rest.length > 0 && restKeys.size === 1) {
      for (const row of disconnects) {
        flags.push(flagFor(row, 'non-owning-process', `${battleId} disconnect tie from a second process`));
      }
      flags.push(...extraPidFlags(rest, 'non-owning-process'));
      continue;
    }
    const keys = new Set(group.map(row => resultKey(view(row))));
    if (keys.size > 1) {
      for (const row of group) {
        flags.push(flagFor(row, 'conflicting-result', `${battleId} has more than one result`));
      }
      continue;
    }
    flags.push(...extraPidFlags(group, 'non-owning-process'));
  }
  return flags;
}

function extraPidFlags(rows: object[], reason: ContaminationReason): ContaminationFlag[] {
  const ranked = [...rows].sort((a, b) => stamp(view(a)) - stamp(view(b)));
  const ownerPid = pidOf(view(ranked[0]));
  const flags: ContaminationFlag[] = [];
  for (const row of rows) {
    const pid = pidOf(view(row));
    if (pid === null || pid === ownerPid) continue;
    flags.push(flagFor(row, reason, `pid ${pid} is not the owning process ${ownerPid ?? 'unknown'}`));
  }
  return flags;
}

export function flagMatches(flag: ContaminationFlag, row: object): boolean {
  if (!flag.exclude || flag.battleId !== battleIdOf(row)) return false;
  const record = view(row);
  if (flag.pid !== null && flag.pid !== pidOf(record)) return false;
  if (flag.ts !== null && flag.ts !== tsOf(record)) return false;
  return true;
}

export function rowExcluded(row: object, flags: readonly ContaminationFlag[]): boolean {
  if (!isLadderGameRow(row)) return false;
  if (view(row).contaminated === true) return true;
  return flags.some(flag => flagMatches(flag, row));
}

/**
 * One countable row per battle. Phantoms, contaminated rows, and conflicting
 * results are out. Agreeing copies collapse to the earliest.
 */
export function countableGameRows<T extends object>(rows: readonly T[], extraFlags: readonly ContaminationFlag[] = []): T[] {
  const flags = [...contaminationFlagsFor(rows), ...extraFlags.filter(flag => flag.exclude)];
  const kept: T[] = [];
  for (const row of rows) {
    if (!isLadderGameRow(row)) continue;
    if (isPhantomRecord(view(row))) continue;
    if (rowExcluded(row, flags)) continue;
    kept.push(row);
  }
  const byId = new Map<string, T>();
  const noId: T[] = [];
  for (const row of kept) {
    const id = battleIdOf(row);
    if (!id) {
      noId.push(row);
      continue;
    }
    const prev = byId.get(id);
    if (!prev || stamp(view(row)) < stamp(view(prev))) byId.set(id, row);
  }
  return [...byId.values(), ...noId];
}

/**
 * Cross-file merge. Same outcome collapses. A disconnect tie loses to a
 * decisive result. Two decisive results drop the battle.
 */
export function battleRowChoice<T extends { outcome?: string | null; endReason?: string | null; turns?: number | null; contaminated?: boolean }>(
  a: T,
  b: T,
): 'a' | 'b' | 'drop' | 'merge' {
  if (a.contaminated && !b.contaminated) return 'b';
  if (b.contaminated && !a.contaminated) return 'a';
  if (a.contaminated && b.contaminated) return 'drop';
  if (a.outcome && b.outcome && a.outcome !== b.outcome) {
    if (isDuplicateDisconnect(a) && !isDuplicateDisconnect(b)) return 'b';
    if (isDuplicateDisconnect(b) && !isDuplicateDisconnect(a)) return 'a';
    return 'drop';
  }
  return 'merge';
}

export function contaminationPath(gameFileOrDir: string): string {
  const dir = gameFileOrDir.endsWith('.jsonl') ? path.dirname(gameFileOrDir) : gameFileOrDir;
  return path.join(dir, CONTAMINATION_FILE);
}

export function loadContaminationFlags(gameFileOrDir: string): ContaminationFlag[] {
  const file = contaminationPath(gameFileOrDir);
  if (!fs.existsSync(file)) return [];
  const flags: ContaminationFlag[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as ContaminationFlag;
      if (row && row.schema === CONTAMINATION_SCHEMA && row.exclude && typeof row.battleId === 'string') flags.push(row);
    } catch {
      // A torn flag line is ignored. The game log is not touched.
    }
  }
  return flags;
}

function flagKey(flag: ContaminationFlag): string {
  return `${flag.battleId}|${flag.pid ?? ''}|${flag.ts ?? ''}|${flag.reason}`;
}

/**
 * Flag contaminated historical rows. The game log's bytes stay as they were.
 */
export function repairGameLog(file: string): { flagged: number } {
  if (!fs.existsSync(file)) return { flagged: 0 };
  const before = fs.readFileSync(file);
  const rows: object[] = [];
  for (const line of before.toString('utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as object;
      if (row && typeof row === 'object') rows.push(row);
    } catch {
      // Keep going. Repair does not rewrite the source line.
    }
  }
  const existing = loadContaminationFlags(file);
  const seen = new Set(existing.map(flagKey));
  const novel = contaminationFlagsFor(rows).filter(flag => !seen.has(flagKey(flag)));
  if (novel.length > 0) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(contaminationPath(file), novel.map(flag => JSON.stringify(flag)).join('\n') + '\n');
  }
  const after = fs.readFileSync(file);
  if (!before.equals(after)) throw new Error(`repair changed ${file}`);
  return { flagged: novel.length };
}

/** Duplicate battle ids, null replay links, and null required fields. Phantoms are not field-checked. */
export function checkGameInvariants(rows: readonly object[]): InvariantFinding[] {
  const findings: InvariantFinding[] = [];
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!isLadderGameRow(row)) continue;
    const id = battleIdOf(row);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    if (isPhantomRecord(view(row))) continue;
    const record = row as Record<string, unknown>;
    for (const field of REQUIRED_GAME_FIELDS) {
      if (!requiredFieldMissing(record, field)) continue;
      if (field === 'replayUrl') {
        findings.push({
          code: 'null-replay-url',
          battleId: id,
          field,
          detail: `${id ?? 'row'} replayUrl is null`,
        });
      }
      findings.push({
        code: 'null-required-field',
        battleId: id,
        field,
        detail: `${id ?? 'row'} ${field} is null`,
      });
    }
  }
  for (const [id, count] of counts) {
    if (count > 1) {
      findings.push({
        code: 'duplicate-battle-id',
        battleId: id,
        detail: `${id} appears ${count} times`,
      });
    }
  }
  return findings;
}

/**
 * A null opponent rating or eloAfter is recorded when its reason is set.
 * Those nulls are not a missing field. A numeric stand-in is not required.
 */
function requiredFieldMissing(record: Record<string, unknown>, field: string): boolean {
  if (field === 'opponentRating' && record.opponentRatingReason === 'unreported') return false;
  if (field === 'eloAfter' && typeof record.eloAfterReason === 'string' && record.eloAfterReason.trim()) return false;
  const value = record[field];
  return value === null || value === undefined || (typeof value === 'string' && !value.trim());
}

export function readGameObjects(file: string): object[] {
  if (!fs.existsSync(file)) return [];
  const rows: object[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as object;
      if (row && typeof row === 'object') rows.push(row);
    } catch {
      // Same rule as the analyst: a torn line is not a game.
    }
  }
  return rows;
}
