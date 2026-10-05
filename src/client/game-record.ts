import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { currentHostname, readBatchLabel } from './run-stamp.js';
import { configIdOf } from '../config/hash.js';
import { toID } from './ids.js';
import { ourClockUpdate } from './inactive-clock.js';
import { parseRatingLine, parseReplayUrl } from './showdown-client.js';
import { percentile } from './live-metrics.js';
import type { CalibrationSummary } from './prediction.js';

/**
 * One finished game. The ladder client appends it to `{logDir}/games.jsonl`.
 * `ops live` appends the same fields to `live-games.jsonl`.
 * The per-battle JSONL also stores this object as `type: "result"`.
 *
 * Per-turn rows keep `searchMs` (engine time), `latencyMs` (wall clock
 * choosing), and `secondsLeft`. Game rows use the same latency names as
 * `logs/ladder/metrics.jsonl`: `latencyP50Ms`, `latencyP95Ms`,
 * `latencyP99Ms`, plus `latencyMaxMs` and `minTimerMarginSec`.
 * Missing Elo and GXE stay null. This file does not invent 1000 or 50.
 */
export const LADDER_GAME_SCHEMA = 'jev.ladder-game.v1' as const;

/** Enough of the incident loop to classify a game without storing the whole log. */
export const INVALID_CHOICE_REASON_CAP = 8;

/**
 * Reason text after `[Invalid choice]` on an `|error|` or `|bigerror|` line.
 * Other lines, including a chat echo of the same words, are not a rejection.
 */
export function invalidChoiceReason(line: string): string | null {
  if (!line.startsWith('|error|') && !line.startsWith('|bigerror|')) return null;
  if (!/\[Invalid choice\]/i.test(line)) return null;
  const text = line.replace(/^.*?\[Invalid choice\]\s*/i, '').trim();
  return text || 'invalid choice';
}

export function cappedInvalidChoiceReasons(reasons: readonly string[]): string[] {
  return reasons.slice(0, INVALID_CHOICE_REASON_CAP);
}

function reasonsFromLines(lines: readonly string[]): string[] {
  const reasons: string[] = [];
  for (const line of lines) {
    const reason = invalidChoiceReason(line);
    if (reason) reasons.push(reason);
  }
  return reasons;
}

export type GameEndReason =
  | 'ko'
  | 'opponent-forfeit'
  | 'our-forfeit'
  | 'our-timer'
  | 'opponent-timer'
  | 'disconnect'
  | 'crash'
  | 'tie'
  | 'unknown';

export interface LadderGameRecord {
  schema: typeof LADDER_GAME_SCHEMA;
  kind: 'ladder-game';
  source: 'ladder' | 'ops';
  /** Stable id for the ops analyst. `{battleId}-{ts}` when the caller omits it. */
  id: string;
  pid: number;
  /** Ladder run id printed at startup (`[ladder] pid=… run=…`). */
  runId: string;
  /** `LIVE_BATCH_LABEL`, or the log file name when stdout is a `.log`. Null when neither is set. */
  batchLabel: string | null;
  hostname: string;
  ts: number;
  startedAt: number;
  battleId: string;
  format: string;
  username: string;
  opponent: string | null;
  opponentRating: number | null;
  outcome: 'win' | 'loss' | 'tie';
  endReason: GameEndReason;
  winner: string | null;
  turns: number;
  invalidChoices: number;
  /**
   * Server text after `[Invalid choice]`, one entry per `|error|` or `|bigerror|`
   * line, capped at 8. A later chat echo of the same words is not an entry.
   */
  invalidChoiceReasons: string[];
  crashes: number;
  fallbacks: number;
  mismatches: number;
  /**
   * Posterior updates that threw in this game. The battle then used BeliefTracker.
   * 0 when set inference is not calibrated.
   */
  beliefErrors: number;
  eloBefore: number | null;
  eloAfter: number | null;
  /** Null when the server line had no GXE. Never defaulted. */
  gxe: number | null;
  durationMs: number;
  /** Decision samples. Same count `metrics.jsonl` calls `decisions`. */
  decisions: number;
  /** Nearest-rank percentiles of per-turn `latencyMs`. Null when `decisions` is 0. */
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  latencyP99Ms: number | null;
  latencyMaxMs: number | null;
  /** Smallest Showdown seconds-left observed for us. Null if no timer line. */
  minTimerMarginSec: number | null;
  engine: string;
  configId: string | null;
  configHash: string | null;
  gitSha: string | null;
  /** Set when the ladder routed this battle. Absent on older rows and on `ops live`. */
  role?: 'champion' | 'challenger';
  /** Share of new battles this config was given, as a fraction in (0, 1]. */
  share?: number;
  concurrency: number;
  replayId: string | null;
  replayUrl: string | null;
  localReplayPath: string | null;
  replayUploaded: boolean;
  replayStatus: 'confirmed' | 'unconfirmed' | 'local-only';
  logPath: string;
  /**
   * Opened room that never played a turn and never received `|win|` or `|tie|`.
   * A drain writes these when a ghost room is still on the socket. Dashboard
   * and analyst totals skip them.
   */
  phantom?: true;
  /** Seat we occupied. Absent when the protocol never named us. */
  ourSide?: 'p1' | 'p2';
  /**
   * Sim-versus-protocol totals for this game. Omitted when no turn was forecast.
   * Counts are exact; rates are nearest 1/10000.
   */
  calibration?: CalibrationSummary;
  /** Present on `ops live` rows. The ladder client leaves these off. */
  configPath?: string;
  variantId?: string;
  inputLog?: string;
  log?: string;
}

/** @deprecated Use LadderGameRecord. Kept so existing imports keep compiling. */
export type GameSummary = LadderGameRecord;

export function gxeOf(rating: object | null | undefined): number | null {
  if (!rating || !('gxe' in rating)) return null;
  const gxe = (rating as { gxe?: unknown }).gxe;
  return typeof gxe === 'number' && Number.isFinite(gxe) ? gxe : null;
}

export { percentile };

export function latencyFields(values: number[], minTimerMarginSec: number | null): {
  decisions: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  latencyP99Ms: number | null;
  latencyMaxMs: number | null;
  minTimerMarginSec: number | null;
} {
  const samples = values.filter(value => Number.isFinite(value));
  if (samples.length === 0) {
    return {
      decisions: 0,
      latencyP50Ms: null,
      latencyP95Ms: null,
      latencyP99Ms: null,
      latencyMaxMs: null,
      minTimerMarginSec,
    };
  }
  return {
    decisions: samples.length,
    latencyP50Ms: percentile(samples, 50),
    latencyP95Ms: percentile(samples, 95),
    latencyP99Ms: percentile(samples, 99),
    latencyMaxMs: Math.max(...samples),
    minTimerMarginSec,
  };
}

function messageBody(line: string): string {
  const text = line.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  for (const marker of ['|-message|', '|message|', '|inactive|', '|bigerror|', '|raw|', '|error|']) {
    if (text.startsWith(marker)) return text.slice(marker.length).trim();
  }
  return text;
}

function ours(name: string, username: string): boolean {
  return toID(name) === toID(username);
}

/** A room with no turns and no `|win|` or `|tie|` is not a played game. */
export function isPhantomGame(input: {
  turns: number;
  winner: string | null;
  lines: readonly string[];
}): boolean {
  if (input.turns > 0) return false;
  if (input.winner && input.winner.trim()) return false;
  for (const line of input.lines) {
    if (line.startsWith('|win|') || line === '|tie' || line.startsWith('|tie|')) return false;
  }
  return true;
}

/**
 * Historical `games.jsonl` rows have no protocol lines. A 0-turn tie whose
 * reason is disconnect or unknown is the same ghost room.
 */
export function isPhantomRecord(row: {
  phantom?: unknown;
  turns?: unknown;
  winner?: unknown;
  outcome?: unknown;
  endReason?: unknown;
}): boolean {
  if (row.phantom === true) return true;
  const turns = typeof row.turns === 'number' ? row.turns : null;
  if (turns === null || turns > 0) return false;
  if (row.outcome === 'win' || row.outcome === 'loss') return false;
  const winner = typeof row.winner === 'string' ? row.winner.trim() : '';
  if (winner && winner !== 'tie') return false;
  return row.outcome === 'tie' && (row.endReason === 'disconnect' || row.endReason === 'unknown');
}

/** Local server Elo is not a ladder rating. */
export function isLocalLiveGame(game: { localServer?: boolean; replayStatus?: string | null }): boolean {
  return game.localServer === true || game.replayStatus === 'local-only';
}

/**
 * Smallest turn clock recorded for us: the private `Time left: N sec` line,
 * or a public line that names us. Opponent clocks are ignored.
 */
export function timerMarginSec(lines: readonly string[], username: string): number | null {
  let margin: number | null = null;
  for (const line of lines) {
    const clock = ourClockUpdate(line, username);
    if (typeof clock !== 'number') continue;
    margin = margin === null ? clock : Math.min(margin, clock);
  }
  return margin;
}

function tighterMargin(passed: number | null, observed: number | null): number | null {
  if (passed === null || !Number.isFinite(passed)) return observed;
  if (observed === null || !Number.isFinite(observed)) return passed;
  return Math.min(passed, observed);
}

/**
 * Why the battle ended. A `|win|` with no forfeit or inactivity line is a KO.
 * No winner and a dropped socket is `disconnect`, not a drawn game's reason.
 * `outcome` stays `win` | `loss` | `tie` (no winner → `tie`) so the existing
 * ladder line does not grow a fourth word. Read `endReason` before counting ties.
 */
export function classifyEnd(input: {
  lines: string[];
  winner: string | null;
  username: string;
  disconnected?: boolean;
}): { outcome: 'win' | 'loss' | 'tie'; endReason: GameEndReason } {
  let last: { kind: 'forfeit' | 'timer' | 'crash'; who?: string } | null = null;
  let tieLine = false;
  for (const line of input.lines) {
    if (line === '|tie' || line.startsWith('|tie|')) tieLine = true;
    const text = messageBody(line);
    const timer = text.match(/^(.*?)\s+lost due to inactivity\b/i);
    if (timer) last = { kind: 'timer', who: timer[1] };
    const forfeited = text.match(/^(.*?)\s+forfeited\b/i);
    if (forfeited) last = { kind: 'forfeit', who: forfeited[1] };
    if (/simulator process crashed|battle crashed/i.test(text)) last = { kind: 'crash' };
  }

  const weWon = input.winner ? ours(input.winner, input.username) : false;
  const outcome: 'win' | 'loss' | 'tie' = input.winner ? (weWon ? 'win' : 'loss') : 'tie';

  if (last?.kind === 'forfeit' && last.who) {
    return { outcome, endReason: ours(last.who, input.username) ? 'our-forfeit' : 'opponent-forfeit' };
  }
  if (last?.kind === 'timer' && last.who) {
    return { outcome, endReason: ours(last.who, input.username) ? 'our-timer' : 'opponent-timer' };
  }
  if (last?.kind === 'crash') return { outcome, endReason: 'crash' };
  if (!input.winner && input.disconnected) return { outcome, endReason: 'disconnect' };
  if (tieLine || !input.winner) return { outcome, endReason: tieLine ? 'tie' : 'unknown' };
  return { outcome, endReason: 'ko' };
}

/** `battle-gen9randombattle-1` → `gen9randombattle-1`, the public replay id. */
export function replayIdFromBattle(battleId: string): string {
  return battleId.startsWith('battle-') ? battleId.slice('battle-'.length) : battleId;
}

export function replayStatusOf(input: {
  replayUrl: string | null;
  localServer: boolean;
}): { replayUploaded: boolean; replayStatus: LadderGameRecord['replayStatus'] } {
  if (input.replayUrl) return { replayUploaded: true, replayStatus: 'confirmed' };
  if (input.localServer) return { replayUploaded: false, replayStatus: 'local-only' };
  return { replayUploaded: false, replayStatus: 'unconfirmed' };
}

export interface LadderGameInput {
  ts?: number;
  startedAt: number;
  battleId: string;
  format: string;
  username: string;
  opponent: string | null;
  opponentRating: number | null;
  lines: string[];
  winner: string | null;
  turns: number;
  invalidChoices: number;
  /** When omitted, reasons are read from `|error|` / `|bigerror|` lines. */
  invalidChoiceReasons?: string[];
  crashes: number;
  fallbacks: number;
  mismatches: number;
  /** Posterior throws. Omitted by older callers; the record stores 0. */
  beliefErrors?: number;
  /** `before` on the rating update for this battle. Null when that update has no before. */
  eloBefore: number | null;
  eloAfter: number | null;
  /** `|player|` rating for us. Kept on the row when the update is dropped. */
  preRating?: number | null;
  gxe: number | null;
  latencies: number[];
  minTimerMarginSec: number | null;
  engine: string;
  configId: string | null;
  configHash: string | null;
  gitSha: string | null;
  role?: 'champion' | 'challenger';
  share?: number;
  concurrency: number;
  replayId: string | null;
  replayUrl: string | null;
  localReplayPath: string | null;
  localServer: boolean;
  disconnected: boolean;
  logPath: string;
  ourSide?: 'p1' | 'p2' | null;
  pid?: number;
  runId?: string;
  batchLabel?: string | null;
  hostname?: string;
  id?: string;
  source?: 'ladder' | 'ops';
  configPath?: string;
  variantId?: string;
  inputLog?: string;
  log?: string;
  calibration?: CalibrationSummary | null;
}

export function buildLadderGameRecord(input: LadderGameInput): LadderGameRecord {
  const ts = input.ts ?? Date.now();
  const classified = classifyEnd({
    lines: input.lines,
    winner: input.winner,
    username: input.username,
    disconnected: input.disconnected,
  });
  const phantom = isPhantomGame({ turns: input.turns, winner: input.winner, lines: input.lines });
  const replay = replayStatusOf({ replayUrl: input.replayUrl, localServer: input.localServer });
  const rated = eloForGame({
    outcome: classified.outcome,
    ratingBefore: input.eloBefore,
    ratingAfter: input.eloAfter,
    preRating: input.preRating ?? null,
  });
  const gxe = rated.eloAfter === null
    ? null
    : (typeof input.gxe === 'number' && Number.isFinite(input.gxe) ? input.gxe : null);
  return {
    schema: LADDER_GAME_SCHEMA,
    kind: 'ladder-game',
    source: input.source ?? 'ladder',
    id: input.id ?? `${input.battleId}-${ts}`,
    pid: input.pid ?? process.pid,
    runId: input.runId?.trim() || `pid-${process.pid}`,
    batchLabel: input.batchLabel !== undefined ? input.batchLabel : readBatchLabel(),
    hostname: input.hostname?.trim() || currentHostname(),
    ts,
    startedAt: input.startedAt,
    battleId: input.battleId,
    format: input.format,
    username: input.username,
    opponent: input.opponent,
    opponentRating: input.opponentRating,
    outcome: classified.outcome,
    endReason: classified.endReason,
    winner: input.winner,
    turns: input.turns,
    ...(phantom ? { phantom: true as const } : {}),
    invalidChoices: input.invalidChoices,
    invalidChoiceReasons: cappedInvalidChoiceReasons(input.invalidChoiceReasons ?? reasonsFromLines(input.lines)),
    crashes: input.crashes,
    fallbacks: input.fallbacks,
    mismatches: input.mismatches,
    beliefErrors: input.beliefErrors ?? 0,
    eloBefore: rated.eloBefore,
    eloAfter: rated.eloAfter,
    gxe,
    durationMs: Math.max(0, ts - input.startedAt),
    ...latencyFields(input.latencies, tighterMargin(input.minTimerMarginSec, timerMarginSec(input.lines, input.username))),
    engine: input.engine,
    configId: input.configId,
    configHash: input.configHash,
    gitSha: input.gitSha,
    ...(input.role ? { role: input.role } : {}),
    ...(typeof input.share === 'number' ? { share: input.share } : {}),
    concurrency: input.concurrency,
    replayId: input.replayId ?? replayIdFromBattle(input.battleId),
    replayUrl: input.replayUrl,
    localReplayPath: input.localReplayPath,
    replayUploaded: replay.replayUploaded,
    replayStatus: replay.replayStatus,
    logPath: input.logPath,
    ...(input.ourSide === 'p1' || input.ourSide === 'p2' ? { ourSide: input.ourSide } : {}),
    ...(input.configPath ? { configPath: input.configPath } : {}),
    ...(input.variantId ? { variantId: input.variantId } : {}),
    ...(input.inputLog !== undefined ? { inputLog: input.inputLog } : {}),
    ...(input.log !== undefined ? { log: input.log } : {}),
    ...(input.calibration ? { calibration: input.calibration } : {}),
  };
}

export function gamesJsonlPath(dir: string): string {
  return path.join(dir, 'games.jsonl');
}

export function appendGameRecord(dir: string, record: LadderGameRecord): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(gamesJsonlPath(dir), `${JSON.stringify(record)}\n`);
}

/** New `jev.ladder-game.v1` rows must name their run. Older rows with no schema are left alone. */
export function assertNewGameRow(row: object): void {
  const record = row as { schema?: unknown; runId?: unknown };
  if (record.schema !== LADDER_GAME_SCHEMA) return;
  if (typeof record.runId !== 'string' || record.runId.trim() === '') {
    throw new Error('new ladder game rows require runId');
  }
}

export interface RunGroup {
  runId: string;
  batchLabel: string | null;
  hostname: string | null;
  wins: number;
  losses: number;
  ties: number;
  games: number;
}

/** One tally per run, in first-seen order. Rows with no runId share `unknown`. */
export function groupByRunId(games: Array<{
  runId?: string | null;
  batchLabel?: string | null;
  hostname?: string | null;
  outcome: 'win' | 'loss' | 'tie';
}>): RunGroup[] {
  const order: string[] = [];
  const groups = new Map<string, RunGroup>();
  for (const game of games) {
    const runId = game.runId?.trim() || 'unknown';
    let group = groups.get(runId);
    if (!group) {
      group = {
        runId,
        batchLabel: game.batchLabel ?? null,
        hostname: game.hostname ?? null,
        wins: 0,
        losses: 0,
        ties: 0,
        games: 0,
      };
      groups.set(runId, group);
      order.push(runId);
    }
    if (!group.batchLabel && game.batchLabel) group.batchLabel = game.batchLabel;
    if (!group.hostname && game.hostname) group.hostname = game.hostname;
    group.games += 1;
    if (game.outcome === 'win') group.wins += 1;
    else if (game.outcome === 'loss') group.losses += 1;
    else group.ties += 1;
  }
  return order.map(id => groups.get(id)!);
}

/** Shape of PR #5 `live-games.jsonl`, with nulls left null. */
export function toOpsLiveGame(record: LadderGameRecord): {
  kind: 'live-game';
  id: string;
  ts: number;
  configId: string | null;
  winner: 'win' | 'loss' | 'tie';
  rating: number | null;
  gxe: number | null;
  opponent: string | null;
  opponentRating: number | null;
  endReason: GameEndReason;
  invalid: number;
  turns: number;
} {
  return {
    kind: 'live-game',
    id: record.battleId,
    ts: record.ts,
    configId: record.configId,
    winner: record.outcome,
    rating: record.eloAfter,
    gxe: record.gxe,
    opponent: record.opponent,
    opponentRating: record.opponentRating,
    endReason: record.endReason,
    invalid: record.invalidChoices,
    turns: record.turns,
  };
}

/** Same 16-hex content hash the config layer stores as `configId`. */
export const configHash = configIdOf;

/**
 * Outcome for readers of both the new game record (`outcome`) and older
 * ops rows that stored `win` | `loss` | `tie` in `winner`.
 */
export function recordedOutcome(game: {
  outcome?: string | null;
  winner?: string | null;
}): 'win' | 'loss' | 'tie' | null {
  const value = game.outcome ?? game.winner;
  return value === 'win' || value === 'loss' || value === 'tie' ? value : null;
}

/**
 * A win must raise Elo and a loss must lower it.
 * Null on either side is not a contradiction: the incident check can keep the row
 * and treat a missing number as unknown. A tie is not judged.
 */
export function eloDeltaConsistent(
  outcome: 'win' | 'loss' | 'tie',
  eloBefore: number | null,
  eloAfter: number | null,
): boolean {
  if (eloBefore === null || eloAfter === null) return true;
  if (!Number.isFinite(eloBefore) || !Number.isFinite(eloAfter)) return true;
  if (outcome === 'win') return eloAfter > eloBefore;
  if (outcome === 'loss') return eloAfter < eloBefore;
  return true;
}

function finiteRating(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Keep `eloAfter` only when it and `ratingBefore` are one update for this battle
 * and the move matches the result. Otherwise `eloAfter` is null.
 * `eloBefore` falls back to the `|player|` rating so the start of the battle is still on the row.
 */
export function eloForGame(input: {
  outcome: 'win' | 'loss' | 'tie';
  ratingBefore: number | null;
  ratingAfter: number | null;
  preRating: number | null;
}): { eloBefore: number | null; eloAfter: number | null } {
  const ratingBefore = finiteRating(input.ratingBefore);
  const ratingAfter = finiteRating(input.ratingAfter);
  const preRating = finiteRating(input.preRating);
  if (
    ratingBefore !== null
    && ratingAfter !== null
    && eloDeltaConsistent(input.outcome, ratingBefore, ratingAfter)
    && (input.outcome === 'tie' || ratingBefore !== ratingAfter)
  ) {
    return { eloBefore: ratingBefore, eloAfter: ratingAfter };
  }
  return { eloBefore: preRating ?? ratingBefore, eloAfter: null };
}

/** Elo after the game. Prefers `eloAfter`. Older ops rows used `rating`. Null stays null. */
export function recordedElo(game: { eloAfter?: number | null; rating?: number | null }): number | null {
  const value = typeof game.eloAfter === 'number' ? game.eloAfter : game.rating;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export interface TranscriptFacts {
  ourSide: 'p1' | 'p2' | null;
  opponent: string | null;
  opponentRating: number | null;
  eloBefore: number | null;
  eloAfter: number | null;
  preRating: number | null;
  gxe: number | null;
  turns: number;
  invalidChoices: number;
  invalidChoiceReasons: string[];
  crashes: number;
  winner: string | null;
  minTimerMarginSec: number | null;
  replayId: string | null;
  replayUrl: string | null;
}

/** Read the shared game fields out of a Showdown transcript. Does not invent Elo or GXE. */
export function factsFromTranscript(lines: string[], username: string): TranscriptFacts {
  const players: Record<string, { name: string; rating: number | null }> = {};
  let ourSide: string | null = null;
  let turns = 0;
  let invalidChoices = 0;
  const invalidChoiceReasons: string[] = [];
  let crashes = 0;
  let winner: string | null = null;
  let eloBefore: number | null = null;
  let eloAfter: number | null = null;
  let preRating: number | null = null;
  let gxe: number | null = null;
  let replayId: string | null = null;
  let replayUrl: string | null = null;

  for (const line of lines) {
    if (line.startsWith('|player|')) {
      const parts = line.split('|');
      const side = parts[2];
      const name = parts[3];
      if ((side === 'p1' || side === 'p2') && name) {
        const rating = parts[5] && /^\d+$/.test(parts[5]) ? Number(parts[5]) : null;
        players[side] = { name, rating };
        if (toID(name) === toID(username)) ourSide = side;
      }
    }
    if (line.startsWith('|turn|')) turns = Number(line.slice('|turn|'.length)) || turns;
    const reason = invalidChoiceReason(line);
    if (reason) {
      invalidChoices += 1;
      if (invalidChoiceReasons.length < INVALID_CHOICE_REASON_CAP) invalidChoiceReasons.push(reason);
    }
    if (/simulator process crashed|battle crashed/i.test(line)) crashes += 1;
    if (line.startsWith('|win|')) winner = line.slice('|win|'.length).trim() || null;

    const html = parseRatingLine(line);
    if (html && (!html.username || toID(html.username) === toID(username))) {
      eloBefore = html.before;
      eloAfter = html.after;
      const parsedGxe = gxeOf(html);
      if (parsedGxe !== null) gxe = parsedGxe;
    }
    const pipe = line.trim().match(/^\|rating\|(\d+(?:\.\d+)?)(?:\|(\d+(?:\.\d+)?))?/);
    if (pipe) {
      eloBefore = null;
      eloAfter = pipe[1] === undefined ? null : Number(pipe[1]);
      gxe = pipe[2] === undefined ? null : Number(pipe[2]);
    }

    const replay = parseReplayUrl(line);
    if (replay) {
      replayId = replay.id;
      replayUrl = replay.url;
    }
  }

  const opponentSide = ourSide === 'p1' ? 'p2' : ourSide === 'p2' ? 'p1' : null;
  const opponent = opponentSide ? players[opponentSide]?.name ?? null : null;
  const opponentRating = opponentSide ? players[opponentSide]?.rating ?? null : null;
  if (ourSide && players[ourSide]?.rating !== null && players[ourSide]?.rating !== undefined) {
    preRating = players[ourSide].rating;
  }

  return {
    ourSide: ourSide === 'p1' || ourSide === 'p2' ? ourSide : null,
    opponent,
    opponentRating,
    eloBefore,
    eloAfter,
    preRating,
    gxe,
    turns,
    invalidChoices,
    invalidChoiceReasons,
    crashes,
    winner,
    minTimerMarginSec: timerMarginSec(lines, username),
    replayId,
    replayUrl,
  };
}

let cachedGitSha: string | null | undefined;

export function currentGitSha(): string | null {
  const fromEnv = process.env.JEV_GIT_SHA || process.env.GIT_COMMIT || process.env.GITHUB_SHA;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  if (cachedGitSha !== undefined) return cachedGitSha;
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    cachedGitSha = sha || null;
  } catch {
    cachedGitSha = null;
  }
  return cachedGitSha;
}
