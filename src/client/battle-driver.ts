import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { Battle } from '@pkmn/client';
import { Generations } from '@pkmn/data';
import { Dex } from '@pkmn/dex';
import { Format } from '../types/format.js';
import { Action, GameState } from '../types/index.js';
import { StateMismatch } from '../types/format.js';
import { ShowdownClient, ReplayNotice, parseRatingLine, parseReplayUrl } from './showdown-client.js';
import { DecisionClient } from './decision-client.js';
import { OpponentTracker } from './opponent-tracker.js';
import { GameLog, openGameLog } from './game-log.js';
import {
  formatChoice,
  isWaitRequest,
  legalActionsForRequest,
  pickBestLegal,
  sameAction,
  sanitizeAction,
  teamPreviewChoice,
} from './choice.js';
import { alignToRequest, cloneGameState, mismatchData, overlayProtocol } from './tracked-state.js';
import { LivePosition } from './decision-battle.js';
import { livePositionFromClient } from './live-position.js';
import { ourClockUpdate } from './inactive-clock.js';
import { safeError, toID } from './ids.js';
import { appendGameRecord, buildLadderGameRecord, LadderGameRecord } from './game-record.js';

export type { LadderGameRecord as GameSummary } from './game-record.js';

interface RoomState {
  roomId: string;
  battle: Battle;
  tracker: OpponentTracker;
  log: GameLog;
  lines: string[];
  ourSide: 'p1' | 'p2' | null;
  players: { p1?: string; p2?: string };
  preRating: { p1?: number; p2?: number };
  snapshot: GameState | null;
  answered: Set<number>;
  invalidChoices: number;
  crashes: number;
  fallbacks: number;
  mismatchCount: number;
  retries: number;
  ended: boolean;
  finalized: boolean;
  winner: string | null;
  turns: number;
  replay: ReplayNotice | null;
  elo: { before: number | null; after: number | null; gxe: number | null; gxeSource: 'html' | 'rating-line' | 'missing' } | null;
  gxe: number | null;
  startedAt: number;
  latencies: number[];
  minTimerMarginSec: number | null;
  disconnected: boolean;
  secondsLeft: number | null;
  lastRequest: any;
  lastLegal: Action[];
  lastChoice: Action | null;
  requestTimer?: NodeJS.Timeout;
  finalizeTimer?: NodeJS.Timeout;
}

export interface BattleDriverOptions {
  client: ShowdownClient;
  username: string;
  format: Format;
  engineName: string;
  decisions: DecisionClient;
  logDir: string;
  decisionTimeoutMs: number;
  replayDir?: string;
  configId?: string | null;
  configHash?: string | null;
  gitSha?: string | null;
  concurrency?: number;
  localServer?: boolean;
  /** How long to wait for a replay popup. Tests use 0. */
  settleMs?: number;
}

/**
 * One user's battle loop: protocol state, request reconciliation,
 * champion decisions, and JSONL records. Never sends /forfeit.
 */
export class BattleDriver extends EventEmitter {
  private readonly rooms = new Map<string, RoomState>();
  private readonly gens = new Generations(Dex);
  private stopped = false;

  constructor(private readonly options: BattleDriverOptions) {
    super();
    const { client } = options;
    client.on('line', (roomId: string, line: string) => {
      this.onLine(roomId, line);
    });
    client.on('replay', (replay: ReplayNotice) => {
      this.onReplay(replay);
    });
    client.on('popup', (message: string) => {
      this.onPopup(message);
    });
    client.on('disconnect', () => {
      for (const room of this.rooms.values()) {
        if (!room.ended) room.disconnected = true;
      }
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const room of [...this.rooms.values()]) {
      if (room.requestTimer) clearTimeout(room.requestTimer);
      if (room.finalizeTimer) clearTimeout(room.finalizeTimer);
      if (!room.finalized) {
        if (!room.ended) room.disconnected = true;
        await this.finalize(room);
      }
    }
    await this.options.decisions.stop();
  }

  private onLine(roomId: string, line: string): void {
    if (this.stopped || !roomId.startsWith('battle-')) return;
    let room = this.rooms.get(roomId);
    if (!room) room = this.openRoom(roomId);
    if (room.finalized) return;

    const clock = ourClockUpdate(line, this.options.username);
    if (clock !== undefined) room.secondsLeft = clock;

    room.lines.push(line);
    this.observePlayers(room, line);
    room.tracker.applyLine(line);

    try {
      room.battle.add(line);
    } catch (err) {
      room.log.write({
        type: 'protocol_error',
        battleId: room.roomId,
        message: safeError(err),
        line,
      });
    }

    if (line.startsWith('|turn|')) {
      room.turns = Number(line.slice('|turn|'.length)) || room.turns;
    }

    if (line.startsWith('|inactive|')) {
      const seconds = line.match(/(\d+) seconds left/);
      const aboutUs = line.includes(this.options.username) || /You have/i.test(line);
      if (seconds && aboutUs) {
        room.secondsLeft = Number(seconds[1]);
        room.minTimerMarginSec = room.minTimerMarginSec === null
          ? room.secondsLeft
          : Math.min(room.minTimerMarginSec, room.secondsLeft);
      }
    }

    const rating = parseRatingLine(line);
    if (rating && (!rating.username || toID(rating.username) === toID(this.options.username))) {
      room.elo = {
        before: rating.before,
        after: rating.after,
        gxe: rating.gxe,
        gxeSource: rating.gxeSource,
      };
      room.gxe = rating.gxe;
      const opponentSide = room.ourSide === 'p1' ? 'p2' : room.ourSide === 'p2' ? 'p1' : null;
      room.log.write({
        type: 'rating',
        kind: 'rating',
        battleId: room.roomId,
        format: this.options.format.id,
        username: rating.username ?? this.options.username,
        before: rating.before,
        after: rating.after,
        gxe: rating.gxe,
        gxeSource: rating.gxeSource,
        opponent: opponentSide ? room.players[opponentSide] ?? null : null,
        opponentRating: opponentSide ? room.preRating[opponentSide] ?? null : null,
        fabricated: false,
      });
    }

    if (line.startsWith('|request|')) {
      const raw = line.slice('|request|'.length);
      if (!raw) return;
      try {
        room.lastRequest = JSON.parse(raw);
      } catch (err) {
        room.log.write({ type: 'error', battleId: room.roomId, message: `bad request json: ${safeError(err)}` });
        return;
      }
      if (room.requestTimer) clearTimeout(room.requestTimer);
      room.requestTimer = setTimeout(() => {
        void this.onRequest(room!, room!.lastRequest);
      }, 20);
      return;
    }

    if (/invalid choice/i.test(line)) {
      room.invalidChoices += 1;
      room.log.write({
        type: 'error',
        battleId: room.roomId,
        invalidChoice: true,
        message: line,
      });
      void this.retryChoice(room, line);
      return;
    }

    if (line.startsWith('|error|') || line.startsWith('|bigerror|')) {
      room.log.write({ type: 'error', battleId: room.roomId, invalidChoice: false, message: line });
      return;
    }

    if (line.startsWith('|win|') || line === '|tie' || line.startsWith('|tie|')) {
      this.markEnded(room, line);
    }
  }

  private openRoom(roomId: string): RoomState {
    const battle = new Battle(this.gens);
    const tracker = new OpponentTracker(this.options.format, () => this.rooms.get(roomId)?.ourSide ?? null);
    const log = openGameLog(this.options.logDir, `${toID(this.options.username)}-${roomId}`);
    const room: RoomState = {
      roomId,
      battle,
      tracker,
      log,
      lines: [],
      ourSide: null,
      players: {},
      preRating: {},
      snapshot: null,
      answered: new Set(),
      invalidChoices: 0,
      crashes: 0,
      fallbacks: 0,
      mismatchCount: 0,
      retries: 0,
      ended: false,
      finalized: false,
      winner: null,
      turns: 0,
      replay: null,
      elo: null,
      gxe: null,
      startedAt: Date.now(),
      latencies: [],
      minTimerMarginSec: null,
      disconnected: false,
      secondsLeft: null,
      lastRequest: null,
      lastLegal: [],
      lastChoice: null,
    };
    this.rooms.set(roomId, room);
    this.options.client.trackRoom(roomId);
    this.options.decisions.openBattle(roomId);
    log.write({
      type: 'game_start',
      battleId: roomId,
      format: this.options.format.id,
      username: this.options.username,
      engine: this.options.engineName,
    });
    this.emit('battleStart', roomId);
    // Partial test clients implement only the methods that battle uses.
    this.options.client.enableBattleTimer?.(roomId);
    return room;
  }

  private observePlayers(room: RoomState, line: string): void {
    if (!line.startsWith('|player|')) return;
    const parts = line.split('|');
    const side = parts[2];
    const name = parts[3];
    if ((side !== 'p1' && side !== 'p2') || !name) return;
    room.players[side] = name;
    if (parts[5] && /^\d+$/.test(parts[5])) room.preRating[side] = Number(parts[5]);
    if (toID(name) === toID(this.options.username)) room.ourSide = side;
  }

  private async onRequest(room: RoomState, request: any): Promise<void> {
    if (room.ended || room.finalized || this.stopped) return;
    if (!request || isWaitRequest(request)) return;

    const rqid = typeof request.rqid === 'number' ? request.rqid : null;
    if (rqid !== null && room.answered.has(rqid)) return;

    const preview = teamPreviewChoice(request);
    if (preview) {
      this.sendChoice(room, preview, rqid, null, true);
      return;
    }

    const legal = legalActionsForRequest(request, this.options.format);
    if (legal.length === 0) {
      room.log.write({
        type: 'turn',
        battleId: room.roomId,
        turn: room.battle.turn,
        rqid,
        skipped: true,
        reason: 'no legal choice',
      });
      return;
    }

    let mismatches: StateMismatch[] = [];
    try {
      mismatches = this.reconcile(room, request);
    } catch (err) {
      room.crashes += 1;
      room.log.write({ type: 'crash', battleId: room.roomId, message: safeError(err) });
    }

    const tracking = room.tracker.tracking();
    const state = this.options.format.buildGameState(request, tracking);
    state.turn = room.battle.turn || state.turn;
    if (room.ourSide) state.playerId = room.ourSide;
    room.snapshot = cloneGameState(state);
    room.lastLegal = legal;
    room.retries = 0;

    const roles = room.tracker.activeRoles().map(role => ({
      role: role.role,
      probability: Number(role.probability.toFixed(4)),
    }));

    const position = this.livePosition(room, request);
    let decision;
    const startedAt = Date.now();
    const tightTimer = room.secondsLeft !== null && room.secondsLeft <= 4;
    try {
      if (tightTimer) {
        decision = {
          action: pickBestLegal(state, legal),
          score: null as number | null,
          timeMs: 0,
          fallback: true,
          reason: `timer has ${room.secondsLeft}s left`,
        };
      } else {
        const budget = this.budgetMs(room);
        decision = await this.options.decisions.decide(room.roomId, state, legal, budget, position);
      }
    } catch (err) {
      room.crashes += 1;
      room.log.write({ type: 'crash', battleId: room.roomId, message: safeError(err) });
      decision = {
        action: pickBestLegal(state, legal),
        score: null as number | null,
        timeMs: 0,
        fallback: true,
        reason: safeError(err),
      };
    }

    const latencyMs = Date.now() - startedAt;
    room.latencies.push(latencyMs);
    if (room.ended || (rqid !== null && room.answered.has(rqid))) {
      this.emit('decision', {
        battleId: room.roomId,
        turn: state.turn,
        latencyMs,
        secondsLeft: room.secondsLeft,
        fallback: Boolean(decision.fallback),
      });
      return;
    }

    const safe = sanitizeAction(decision.action, request, legal) ?? pickBestLegal(state, legal);
    const adjusted = !sameAction(safe, decision.action);
    if (decision.fallback || adjusted) {
      room.fallbacks += 1;
      room.log.write({
        type: 'fallback',
        battleId: room.roomId,
        turn: state.turn,
        rqid,
        reason: decision.reason || (adjusted ? 'removed an illegal modifier from the engine choice' : 'fallback'),
        action: safe,
      });
    }

    const choice = formatChoice(safe, rqid ?? undefined);
    room.log.write({
      type: 'turn',
      kind: 'turn',
      battleId: room.roomId,
      turn: state.turn,
      rqid,
      decision: safe,
      choice,
      score: decision.score,
      searchMs: decision.timeMs,
      latencyMs,
      fallback: decision.fallback || adjusted,
      mismatches: mismatchData(mismatches),
      opponentRoles: roles,
      legalCount: legal.length,
      secondsLeft: room.secondsLeft,
    });
    room.mismatchCount += mismatches.length;
    this.emit('decision', {
      battleId: room.roomId,
      turn: state.turn,
      latencyMs,
      secondsLeft: room.secondsLeft,
      fallback: decision.fallback || adjusted,
    });
    this.sendChoice(room, choice, rqid, safe, false);
  }

  private livePosition(room: RoomState, request: any): LivePosition {
    return livePositionFromClient(room.battle, request, room.ourSide === 'p2' ? 'p2' : 'p1');
  }

  private reconcile(room: RoomState, request: any): StateMismatch[] {
    if (!room.snapshot || !room.ourSide) return [];
    const tracked = alignToRequest(
      overlayProtocol(room.snapshot, room.battle, room.ourSide),
      request,
    );
    const mismatches = this.options.format.reconcileState(tracked, request);
    if (mismatches.length > 0) {
      console.warn(`[${this.options.username}] ${room.roomId} mismatches (turn ${tracked.turn}):`);
      for (const mismatch of mismatches) {
        const prefix = mismatch.severity === 'error' ? '❌' : mismatch.severity === 'warning' ? '⚠️' : 'ℹ️';
        console.warn(`  ${prefix} ${mismatch.field}: tracked=${JSON.stringify(mismatch.tracked)}, actual=${JSON.stringify(mismatch.actual)}`);
      }
    }
    return mismatches;
  }

  private budgetMs(room: RoomState): number {
    let budget = this.options.decisionTimeoutMs;
    if (room.secondsLeft !== null) {
      budget = Math.min(budget, Math.max(250, (room.secondsLeft - 3) * 1000));
    }
    return budget;
  }

  private sendChoice(room: RoomState, choice: string, rqid: number | null, action: Action | null, preview: boolean): void {
    if (this.stopped) return;
    if (!this.options.client.isReady()) return;
    let sent = false;
    try {
      sent = this.options.client.choose(room.roomId, choice);
    } catch (err) {
      if (this.stopped) return;
      room.crashes += 1;
      room.log.write({ type: 'crash', battleId: room.roomId, message: `send failed: ${safeError(err)}` });
      return;
    }
    if (!sent) return;
    if (rqid !== null) room.answered.add(rqid);
    room.lastChoice = action;
    if (preview) {
      room.log.write({ type: 'turn', battleId: room.roomId, turn: 0, rqid, choice, decision: 'team', score: null });
    }
  }

  private async retryChoice(room: RoomState, errorLine: string): Promise<void> {
    if (/not your turn/i.test(errorLine)) return;
    if (room.retries >= 6 || room.lastLegal.length === 0 || !room.lastRequest) return;
    const remaining = room.lastLegal.filter(action => !room.lastChoice || !sameAction(action, room.lastChoice));
    if (remaining.length === 0) return;
    room.retries += 1;
    const rqid = typeof room.lastRequest.rqid === 'number' ? room.lastRequest.rqid : null;
    if (rqid !== null) room.answered.delete(rqid);
    const state = room.snapshot;
    const action = state ? pickBestLegal(state, remaining) : remaining[0];
    const choice = formatChoice(action, rqid ?? undefined);
    room.log.write({
      type: 'fallback',
      battleId: room.roomId,
      reason: 'retry after server rejected the previous choice',
      action,
      choice,
    });
    this.sendChoice(room, choice, rqid, action, false);
  }

  private markEnded(room: RoomState, line: string): void {
    if (room.ended) return;
    room.ended = true;
    if (room.requestTimer) clearTimeout(room.requestTimer);
    if (line.startsWith('|win|')) room.winner = line.slice('|win|'.length).trim();
    try {
      this.options.client.saveReplay(room.roomId);
    } catch (err) {
      room.log.write({ type: 'error', battleId: room.roomId, message: `savereplay failed: ${safeError(err)}` });
    }
    room.finalizeTimer = setTimeout(() => {
      void this.finalize(room);
    }, this.options.settleMs ?? 2000);
  }

  private onPopup(message: string): void {
    const open = [...this.rooms.values()].filter(room => !room.finalized);
    const target = open.find(room => room.ended) ?? open[open.length - 1];
    if (!target) return;
    target.log.write({ type: 'popup', battleId: target.roomId, message });
  }

  private onReplay(replay: ReplayNotice): void {
    const target = [...this.rooms.values()].find(room =>
      room.roomId === replay.id
      || room.roomId === `battle-${replay.id}`
      || room.roomId.endsWith(replay.id),
    );
    if (!target || target.finalized) return;
    target.replay = replay;
    if (!target.ended) return;
    if (target.finalizeTimer) clearTimeout(target.finalizeTimer);
    void this.finalize(target);
  }

  private replayFromLines(room: RoomState): void {
    if (room.replay) return;
    for (let i = room.lines.length - 1; i >= 0; i--) {
      const found = parseReplayUrl(room.lines[i]);
      if (found) {
        room.replay = found;
        return;
      }
    }
  }

  private async finalize(room: RoomState): Promise<void> {
    if (room.finalized) return;
    room.finalized = true;
    const opponentSide = room.ourSide === 'p1' ? 'p2' : room.ourSide === 'p2' ? 'p1' : null;
    const opponent = opponentSide ? room.players[opponentSide] ?? null : null;
    const eloBefore = room.elo?.before ?? (room.ourSide ? room.preRating[room.ourSide] ?? null : null);
    const eloAfter = room.elo?.after ?? null;
    const replayDir = this.options.replayDir ?? path.join(this.options.logDir, 'replays');
    fs.mkdirSync(replayDir, { recursive: true });
    const localReplayPath = path.join(
      replayDir,
      `${toID(this.options.username)}-${room.roomId.replace(/[^a-zA-Z0-9_-]+/g, '_')}.log`,
    );
    fs.writeFileSync(localReplayPath, room.lines.join('\n'));
    this.replayFromLines(room);

    const summary: LadderGameRecord = buildLadderGameRecord({
      startedAt: room.startedAt,
      battleId: room.roomId,
      format: this.options.format.id,
      username: this.options.username,
      opponent,
      opponentRating: opponentSide ? room.preRating[opponentSide] ?? null : null,
      lines: room.lines,
      winner: room.winner,
      turns: room.turns || room.battle.turn || 0,
      invalidChoices: room.invalidChoices,
      crashes: room.crashes,
      fallbacks: room.fallbacks,
      mismatches: room.mismatchCount,
      eloBefore,
      eloAfter,
      gxe: room.gxe,
      latencies: room.latencies,
      minTimerMarginSec: room.minTimerMarginSec,
      engine: this.options.engineName,
      configId: this.options.configId ?? null,
      configHash: this.options.configHash ?? null,
      gitSha: this.options.gitSha ?? null,
      concurrency: this.options.concurrency ?? 1,
      replayId: room.replay?.id ?? null,
      replayUrl: room.replay?.url ?? null,
      localReplayPath,
      localServer: this.options.localServer ?? false,
      disconnected: room.disconnected,
      logPath: room.log.filePath,
    });

    room.log.write({
      type: 'result',
      ...summary,
      gxeSource: room.elo?.gxeSource ?? 'missing',
    });
    appendGameRecord(this.options.logDir, summary);
    this.options.decisions.closeBattle(room.roomId);
    await room.log.close();
    this.options.client.untrackRoom(room.roomId);
    room.lines = [];
    this.rooms.delete(room.roomId);
    this.emit('gameEnd', summary);
  }
}
