import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { Battle } from '@pkmn/client';
import { Generations } from '@pkmn/data';
import { Dex } from '@pkmn/dex';
import { Format } from '../types/format.js';
import { Action, GameState } from '../types/index.js';
import { StateMismatch } from '../types/format.js';
import { ShowdownClient, ReplayNotice, parseRatingLine, parseReplayUrl, replayMatchesRoom } from './showdown-client.js';
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
import { attributePopup } from './delivery.js';

export type GameSummary = LadderGameRecord & {
  choiceDeliveryFailures: number;
  noLegalRetries: number;
  ambiguousPopups: number;
};

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
  lastChoiceText: string | null;
  /** Choice the server has not confirmed with a new turn or request. */
  unconfirmed: { choice: string; rqid: number | null; turn: number; resends: number } | null;
  pendingDelivery: number | null;
  choiceDeliveryFailures: number;
  noLegalRetries: number;
  ambiguousPopups: number;
  noLegalRetryLogged: boolean;
  requestTimer?: NodeJS.Timeout;
  finalizeTimer?: NodeJS.Timeout;
  deliveryTimer?: NodeJS.Timeout;
  /** Fires when a sent choice gets no request and no later turn. */
  choiceWatchTimer?: NodeJS.Timeout;
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
  configPath?: string | null;
  concurrency?: number;
  localServer?: boolean;
  /** Delay between choice-delivery retries. Tests use a few milliseconds. */
  deliveryRetryMs?: number;
  /**
   * After `/choose` returns true, resend if this many milliseconds pass with
   * no new `|request|` and no later `|turn|`. Tests use a few milliseconds.
   */
  choiceWatchMs?: number;
  /** How long to wait for a replay popup. Tests use 0. */
  settleMs?: number;
}

const DELIVERY_ATTEMPTS = 3;
/** Silence after a sent choice before the same choice is sent again. */
const CHOICE_WATCH_MS = 8000;
/** Enough 8s resends to cover a 150s turn that the server never acknowledges. */
const WATCHDOG_RESENDS = 20;

/**
 * One user's battle loop: protocol state, request reconciliation,
 * champion decisions, and JSONL records. Never sends /forfeit.
 */
export class BattleDriver extends EventEmitter {
  private readonly rooms = new Map<string, RoomState>();
  /** Room ids that already wrote a result. Later lines must not open them again. */
  private readonly closedRooms = new Set<string>();
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

  roomCount(): number {
    return this.rooms.size;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const room of [...this.rooms.values()]) {
      if (room.requestTimer) clearTimeout(room.requestTimer);
      if (room.finalizeTimer) clearTimeout(room.finalizeTimer);
      if (room.deliveryTimer) clearTimeout(room.deliveryTimer);
      this.clearChoiceWatch(room);
      if (!room.finalized) {
        if (!room.ended) room.disconnected = true;
        await this.finalize(room);
      }
    }
    await this.options.decisions.stop();
  }

  private onLine(roomId: string, line: string): void {
    if (this.stopped || !roomId.startsWith('battle-')) return;
    if (this.closedRooms.has(roomId)) return;
    if (this.namesAnotherBattle(roomId, line)) return;
    let room = this.rooms.get(roomId);
    if (!room) room = this.openRoom(roomId);
    if (room.finalized) return;

    const clock = ourClockUpdate(line, this.options.username);
    if (clock !== undefined) room.secondsLeft = clock;
    if (typeof clock === 'number') {
      room.minTimerMarginSec = room.minTimerMarginSec === null
        ? clock
        : Math.min(room.minTimerMarginSec, clock);
    }

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
      if (this.turnSettledChoice(room)) this.dropUnconfirmed(room);
    }

    if (line.startsWith('|inactive|') || line.startsWith('|inactiveoff|')) {
      const seconds = line.match(/(\d+) seconds left/);
      const aboutUs = line.includes(this.options.username) || /You have/i.test(line);
      const secondsLeft = seconds ? Number(seconds[1]) : null;
      if (line.startsWith('|inactiveoff|')) {
        if (aboutUs) room.secondsLeft = null;
      } else if (aboutUs) {
        room.secondsLeft = secondsLeft;
        if (secondsLeft !== null) {
          room.minTimerMarginSec = room.minTimerMarginSec === null
            ? secondsLeft
            : Math.min(room.minTimerMarginSec, secondsLeft);
        }
      }
      room.log.write({
        type: 'timer',
        kind: 'timer',
        battleId: room.roomId,
        secondsLeft: aboutUs ? room.secondsLeft : secondsLeft,
        aboutUs,
        raw: line,
        tight: aboutUs && room.secondsLeft !== null && room.secondsLeft <= 4,
      });
      if (typeof clock === 'number') this.resendUnconfirmed(room);
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
      this.dropUnconfirmed(room);
      room.secondsLeft = null;
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
      lastChoiceText: null,
      unconfirmed: null,
      pendingDelivery: null,
      choiceDeliveryFailures: 0,
      noLegalRetries: 0,
      ambiguousPopups: 0,
      noLegalRetryLogged: false,
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
    if (rqid !== null && (room.answered.has(rqid) || room.pendingDelivery === rqid)) return;

    const preview = teamPreviewChoice(request);
    if (preview) {
      this.sendChoice(room, preview, rqid, null, true);
      return;
    }

    const legal = legalActionsForRequest(request, this.options.format);
    if (legal.length === 0) {
      room.log.write({
        type: 'turn',
        kind: 'turn',
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
    if (typeof room.secondsLeft === 'number') {
      room.minTimerMarginSec = room.minTimerMarginSec === null
        ? room.secondsLeft
        : Math.min(room.minTimerMarginSec, room.secondsLeft);
    }
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
    return livePositionFromClient(room.battle, request, room.ourSide === 'p2' ? 'p2' : 'p1', room.lines);
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
    room.pendingDelivery = rqid;
    this.deliver(room, choice, rqid, action, preview, 0);
  }

  private deliver(
    room: RoomState,
    choice: string,
    rqid: number | null,
    action: Action | null,
    preview: boolean,
    attempt: number,
    source: 'choose' | 'watchdog' = 'choose',
    watchdogResends = 0,
  ): void {
    if (this.stopped || room.finalized || room.ended) return;
    if (!this.rqidCurrent(room, rqid)) {
      room.pendingDelivery = null;
      this.dropUnconfirmed(room);
      room.log.write({
        type: 'choice-delivery',
        kind: 'choice-delivery',
        battleId: room.roomId,
        intendedRoomId: room.roomId,
        sentRoomId: null,
        rqid,
        choice,
        sent: false,
        cause: 'stale-rqid',
        serverLine: null,
        retry: attempt,
        replacement: null,
      });
      return;
    }
    const intendedRoomId = room.roomId;
    if (!this.options.client.isReady()) {
      this.failDelivery(room, choice, rqid, action, preview, attempt, 'socket-closed', null, source, watchdogResends, null);
      return;
    }
    let sent = false;
    try {
      sent = this.options.client.choose(intendedRoomId, choice);
    } catch (err) {
      if (this.stopped) return;
      room.crashes += 1;
      const message = `send failed: ${safeError(err)}`;
      room.log.write({ type: 'crash', kind: 'crash', battleId: room.roomId, message });
      this.failDelivery(room, choice, rqid, action, preview, attempt, 'send-threw', message, source, watchdogResends, intendedRoomId);
      return;
    }
    if (!sent) {
      this.failDelivery(room, choice, rqid, action, preview, attempt, 'socket-closed', null, source, watchdogResends, intendedRoomId);
      return;
    }
    if (rqid !== null) room.answered.add(rqid);
    room.pendingDelivery = null;
    room.lastChoice = action;
    room.lastChoiceText = choice;
    room.unconfirmed = {
      choice,
      rqid,
      turn: room.turns,
      resends: source === 'watchdog' ? watchdogResends : 0,
    };
    this.armChoiceWatch(room);
    room.log.write({
      type: 'choice-delivery',
      kind: 'choice-delivery',
      battleId: room.roomId,
      intendedRoomId,
      sentRoomId: intendedRoomId,
      rqid,
      choice,
      sent: true,
      cause: source === 'watchdog' ? 'unconfirmed' : 'sent',
      serverLine: null,
      retry: source === 'watchdog' ? watchdogResends : attempt,
      replacement: null,
    });
    if (preview) {
      room.log.write({ type: 'turn', kind: 'turn', battleId: room.roomId, turn: 0, rqid, choice, decision: 'team', score: null });
    }
  }

  private failDelivery(
    room: RoomState,
    choice: string,
    rqid: number | null,
    action: Action | null,
    preview: boolean,
    attempt: number,
    cause: 'socket-closed' | 'send-threw',
    serverLine: string | null,
    source: 'choose' | 'watchdog' = 'choose',
    watchdogResends = 0,
    sentRoomId: string | null = null,
  ): void {
    const exhausted = attempt + 1 >= DELIVERY_ATTEMPTS;
    room.choiceDeliveryFailures += 1;
    room.log.write({
      type: 'choice-delivery',
      kind: 'choice-delivery',
      battleId: room.roomId,
      intendedRoomId: room.roomId,
      sentRoomId,
      rqid,
      choice,
      sent: false,
      cause,
      serverLine,
      retry: attempt,
      replacement: null,
      exhausted,
    });
    if (exhausted) {
      room.pendingDelivery = null;
      return;
    }
    if (room.deliveryTimer) clearTimeout(room.deliveryTimer);
    room.deliveryTimer = setTimeout(() => {
      room.deliveryTimer = undefined;
      this.deliver(room, choice, rqid, action, preview, attempt + 1, source, watchdogResends);
    }, this.options.deliveryRetryMs ?? 25);
  }

  /**
   * `/choose` returned true and nothing from the server has shown the choice
   * was applied. Send the same string, including the same rqid, to this room
   * again. Turn 1 is included: a choice sent before `|turn|2` is still pending.
   */
  private resendUnconfirmed(room: RoomState): void {
    const pending = room.unconfirmed;
    if (!pending || room.ended || room.finalized || this.stopped) return;
    if (this.turnSettledChoice(room)) {
      this.dropUnconfirmed(room);
      return;
    }
    if (room.pendingDelivery !== null || room.deliveryTimer) return;
    if (pending.resends >= WATCHDOG_RESENDS) return;
    const resends = pending.resends + 1;
    pending.resends = resends;
    this.deliver(room, pending.choice, pending.rqid, room.lastChoice, false, 0, 'watchdog', resends);
  }

  /**
   * `|turn|N` confirms a choice only once the battle has moved past it.
   * A move sent before `|turn|1` is still turn 1: that line starts the turn,
   * it does not mean the server applied the move. Team preview is the
   * exception, because `|turn|1` is what shows the preview choice landed.
   */
  private turnSettledChoice(room: RoomState): boolean {
    const pending = room.unconfirmed;
    if (!pending) return false;
    if (pending.choice.startsWith('team ')) return room.turns !== pending.turn;
    if (pending.turn < 1) return room.turns > 1;
    return room.turns !== pending.turn;
  }

  /** A new `|request|` or a later `|turn|` means this choice is no longer pending. */
  private dropUnconfirmed(room: RoomState): void {
    room.unconfirmed = null;
    this.clearChoiceWatch(room);
  }

  private armChoiceWatch(room: RoomState): void {
    this.clearChoiceWatch(room);
    if (!room.unconfirmed || room.ended || room.finalized || this.stopped) return;
    const delay = this.options.choiceWatchMs ?? CHOICE_WATCH_MS;
    room.choiceWatchTimer = setTimeout(() => {
      room.choiceWatchTimer = undefined;
      this.resendUnconfirmed(room);
    }, delay);
  }

  private clearChoiceWatch(room: RoomState): void {
    if (!room.choiceWatchTimer) return;
    clearTimeout(room.choiceWatchTimer);
    room.choiceWatchTimer = undefined;
  }

  private rqidCurrent(room: RoomState, rqid: number | null): boolean {
    if (rqid === null) return true;
    const current = typeof room.lastRequest?.rqid === 'number' ? room.lastRequest.rqid : null;
    if (current === null) return true;
    return current === rqid;
  }

  private async retryChoice(room: RoomState, errorLine: string): Promise<void> {
    const rqid = typeof room.lastRequest?.rqid === 'number' ? room.lastRequest.rqid : null;
    const cause = /not your turn/i.test(errorLine)
      ? 'not-your-turn'
      : /invalid choice/i.test(errorLine) ? 'illegal' : 'server-rejected';
    if (cause === 'not-your-turn') {
      room.log.write({
        type: 'choice-delivery',
        kind: 'choice-delivery',
        battleId: room.roomId,
        intendedRoomId: room.roomId,
        sentRoomId: null,
        rqid,
        choice: room.lastChoiceText,
        sent: false,
        cause,
        serverLine: errorLine,
        retry: room.retries,
        replacement: null,
      });
      return;
    }
    const blocked = room.retries >= 6 || room.lastLegal.length === 0 || !room.lastRequest;
    const remaining = blocked
      ? []
      : room.lastLegal.filter(action => !room.lastChoice || !sameAction(action, room.lastChoice));
    if (blocked || remaining.length === 0) {
      this.logNoLegalRetry(room, errorLine, rqid);
      return;
    }
    room.retries += 1;
    if (rqid !== null) room.answered.delete(rqid);
    const state = room.snapshot;
    const action = state ? pickBestLegal(state, remaining) : remaining[0];
    const choice = formatChoice(action, rqid ?? undefined);
    room.log.write({
      type: 'choice-delivery',
      kind: 'choice-delivery',
      battleId: room.roomId,
      intendedRoomId: room.roomId,
      sentRoomId: null,
      rqid,
      choice: room.lastChoiceText,
      sent: false,
      cause,
      serverLine: errorLine,
      retry: room.retries,
      replacement: choice,
    });
    room.log.write({
      type: 'fallback',
      kind: 'fallback',
      battleId: room.roomId,
      reason: 'retry after server rejected the previous choice',
      action,
      choice,
    });
    this.sendChoice(room, choice, rqid, action, false);
  }

  private logNoLegalRetry(room: RoomState, errorLine: string, rqid: number | null): void {
    if (room.noLegalRetryLogged) return;
    room.noLegalRetryLogged = true;
    room.noLegalRetries += 1;
    room.log.write({
      type: 'choice-delivery',
      kind: 'choice-delivery',
      battleId: room.roomId,
      intendedRoomId: room.roomId,
      sentRoomId: null,
      rqid,
      choice: room.lastChoiceText,
      sent: false,
      cause: 'no-legal-retry',
      serverLine: errorLine,
      retry: room.retries,
      replacement: null,
    });
  }

  private markEnded(room: RoomState, line: string): void {
    if (room.ended) return;
    room.ended = true;
    if (room.requestTimer) clearTimeout(room.requestTimer);
    if (room.deliveryTimer) clearTimeout(room.deliveryTimer);
    this.dropUnconfirmed(room);
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

  /** A replay or popup line that names some other battle is not this room's. */
  private namesAnotherBattle(roomId: string, line: string): boolean {
    if (!line.startsWith('|popup|') && !line.includes('replay.pokemonshowdown.com/')) return false;
    const open = [...this.rooms.keys()];
    if (!open.includes(roomId)) open.push(roomId);
    const attribution = attributePopup(line, open);
    if (attribution.attribution === 'elsewhere') return true;
    return attribution.attribution === 'matched' && attribution.roomId !== roomId;
  }

  private onPopup(message: string): void {
    const open = [...this.rooms.values()].filter(room => !room.finalized);
    const attribution = attributePopup(message, open.map(room => room.roomId));
    if (attribution.attribution === 'elsewhere') return;
    if (attribution.attribution === 'ambiguous') {
      for (const room of open) {
        room.ambiguousPopups += 1;
        room.log.write({
          type: 'popup',
          kind: 'popup',
          battleId: room.roomId,
          message,
          ambiguous: true,
          attribution: 'ambiguous',
          candidates: attribution.candidates,
        });
      }
      return;
    }
    const target = open.find(room => room.roomId === attribution.roomId);
    if (!target) return;
    target.log.write({
      type: 'popup',
      kind: 'popup',
      battleId: target.roomId,
      message,
      ambiguous: false,
      attribution: attribution.attribution,
      candidates: [target.roomId],
    });
  }

  private onReplay(replay: ReplayNotice): void {
    const target = [...this.rooms.values()].find(room => replayMatchesRoom(room.roomId, replay.id));
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
    this.closedRooms.add(room.roomId);
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

    const record = buildLadderGameRecord({
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
      ourSide: room.ourSide,
      configId: this.options.configId ?? null,
      configHash: this.options.configHash ?? null,
      gitSha: this.options.gitSha ?? null,
      configPath: this.options.configPath ?? undefined,
      concurrency: this.options.concurrency ?? 1,
      replayId: room.replay?.id ?? null,
      replayUrl: room.replay?.url ?? null,
      localReplayPath,
      localServer: this.options.localServer ?? false,
      disconnected: room.disconnected,
      logPath: room.log.filePath,
    });
    const summary: GameSummary = {
      ...record,
      choiceDeliveryFailures: room.choiceDeliveryFailures,
      noLegalRetries: room.noLegalRetries,
      ambiguousPopups: room.ambiguousPopups,
    };

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
