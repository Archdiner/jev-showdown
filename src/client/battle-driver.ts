import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { Battle } from '@pkmn/client';
import { Generations } from '@pkmn/data';
import { Dex } from '@pkmn/dex';
import { Format } from '../types/format.js';
import { Action, GameState } from '../types/index.js';
import { StateMismatch } from '../types/format.js';
import { ShowdownClient, ReplayNotice, parseRatingLine } from './showdown-client.js';
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
import { safeError, toID } from './ids.js';

export interface GameSummary {
  battleId: string;
  format: string;
  username: string;
  opponent: string | null;
  outcome: 'win' | 'loss' | 'tie';
  winner: string | null;
  turns: number;
  replayId: string | null;
  replayUrl: string | null;
  localReplayPath: string;
  eloBefore: number | null;
  eloAfter: number | null;
  invalidChoices: number;
  crashes: number;
  fallbacks: number;
  mismatches: number;
  logPath: string;
}

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
  elo: { before: number; after: number } | null;
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
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const room of this.rooms.values()) {
      if (room.requestTimer) clearTimeout(room.requestTimer);
      if (room.finalizeTimer) clearTimeout(room.finalizeTimer);
      if (!room.finalized && room.ended) await this.finalize(room);
    }
    await this.options.decisions.stop();
  }

  private onLine(roomId: string, line: string): void {
    if (this.stopped || !roomId.startsWith('battle-')) return;
    let room = this.rooms.get(roomId);
    if (!room) room = this.openRoom(roomId);
    if (room.finalized) return;

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
      if (seconds && aboutUs) room.secondsLeft = Number(seconds[1]);
    }

    const rating = parseRatingLine(line);
    if (rating && toID(rating.username) === toID(this.options.username)) {
      room.elo = { before: rating.before, after: rating.after };
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

    let decision;
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
        decision = await this.options.decisions.decide(room.roomId, state, legal, budget);
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

    if (room.ended || (rqid !== null && room.answered.has(rqid))) return;

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
      battleId: room.roomId,
      turn: state.turn,
      rqid,
      decision: safe,
      choice,
      score: decision.score,
      searchMs: decision.timeMs,
      fallback: decision.fallback || adjusted,
      mismatches: mismatchData(mismatches),
      opponentRoles: roles,
      legalCount: legal.length,
      secondsLeft: room.secondsLeft,
    });
    room.mismatchCount += mismatches.length;
    this.sendChoice(room, choice, rqid, safe, false);
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
    if (rqid !== null) room.answered.add(rqid);
    room.lastChoice = action;
    try {
      this.options.client.choose(room.roomId, choice);
    } catch (err) {
      if (this.stopped) return;
      room.crashes += 1;
      room.log.write({ type: 'crash', battleId: room.roomId, message: `send failed: ${safeError(err)}` });
      return;
    }
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
    }, 2000);
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
    if (target) target.replay = replay;
  }

  private async finalize(room: RoomState): Promise<void> {
    if (room.finalized) return;
    room.finalized = true;
    const opponentSide = room.ourSide === 'p1' ? 'p2' : room.ourSide === 'p2' ? 'p1' : null;
    const opponent = opponentSide ? room.players[opponentSide] ?? null : null;
    const weWon = room.winner ? toID(room.winner) === toID(this.options.username) : false;
    const outcome = room.winner ? (weWon ? 'win' : 'loss') : 'tie';
    const eloBefore = room.elo?.before ?? (room.ourSide ? room.preRating[room.ourSide] ?? null : null);
    const eloAfter = room.elo?.after ?? null;
    const replayDir = this.options.replayDir ?? path.join(this.options.logDir, 'replays');
    fs.mkdirSync(replayDir, { recursive: true });
    const localReplayPath = path.join(
      replayDir,
      `${toID(this.options.username)}-${room.roomId.replace(/[^a-zA-Z0-9_-]+/g, '_')}.log`,
    );
    fs.writeFileSync(localReplayPath, room.lines.join('\n'));

    const summary: GameSummary = {
      battleId: room.roomId,
      format: this.options.format.id,
      username: this.options.username,
      opponent,
      outcome,
      winner: room.winner,
      turns: room.turns || room.battle.turn || 0,
      replayId: room.replay?.id ?? null,
      replayUrl: room.replay?.url ?? null,
      localReplayPath,
      eloBefore,
      eloAfter,
      invalidChoices: room.invalidChoices,
      crashes: room.crashes,
      fallbacks: room.fallbacks,
      mismatches: room.mismatchCount,
      logPath: room.log.filePath,
    };

    room.log.write({ type: 'result', ...summary });
    this.options.decisions.closeBattle(room.roomId);
    await room.log.close();
    this.options.client.untrackRoom(room.roomId);
    this.emit('gameEnd', summary);
  }
}
