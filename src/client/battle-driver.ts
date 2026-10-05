import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { Battle } from '@pkmn/client';
import { Generations } from '@pkmn/data';
import { Dex } from '@pkmn/dex';
import { Format } from '../types/format.js';
import { Action, GameState } from '../types/index.js';
import { StateMismatch } from '../types/format.js';
import { ShowdownClient, RatingUpdate, ReplayNotice, parseRatingLine, parseReplayUrl, replayMatchesRoom } from './showdown-client.js';
import { DecisionClient } from './decision-client.js';
import { OpponentTracker, type OpponentTrackerOptions } from './opponent-tracker.js';
import { loadConfig } from '../config/load.js';
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
import { LivePosition, buildDecisionBattle, usesDecisionEnrichment } from './decision-battle.js';
import { livePositionFromClient } from './live-position.js';
import { ourClockUpdate } from './inactive-clock.js';
import { safeError, toID } from './ids.js';
import { EngineName, parseEngine } from './engines.js';
import {
  appendGameRecord,
  buildLadderGameRecord,
  cappedInvalidChoiceReasons,
  claimBattle,
  classifyEnd,
  eloDeltaConsistent,
  invalidChoiceReason,
  LadderGameRecord,
} from './game-record.js';
import { attributePopup } from './delivery.js';
import { EXACT_1PLY, EXACT_1PLY_QW, QUICK_WIN_SEARCH_ID, type ExactConfig } from '../engine/exact/search.js';
import { ladderPolicy } from './ladder-engine.js';
import { PredictionLog, PredictionScore } from './prediction.js';
import { TurnForecast, forecastLine, hpFraction, hpFractionText } from './turn-forecast.js';

export type GameSummary = LadderGameRecord & {
  choiceDeliveryFailures: number;
  noLegalRetries: number;
  ambiguousPopups: number;
};

function ourHpFromRequest(request: any): number | null {
  const slots: any[] = request?.side?.pokemon || [];
  const active = slots.find(mon => mon?.active) || slots[0];
  const fraction = hpFractionText(typeof active?.condition === 'string' ? active.condition : null);
  return fraction === null ? null : Math.round(fraction * 10000) / 10000;
}

function foeHpFrom(position: LivePosition): number | null {
  const foe = position.foeActive;
  if (!foe) return null;
  const fraction = hpFraction(foe.hp, foe.maxhp, foe.fainted);
  return fraction === null ? null : Math.round(fraction * 10000) / 10000;
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
  invalidChoiceReasons: string[];
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
  /**
   * Choice the server has not confirmed with a new turn or request.
   * Silence is the opponent still choosing. A later clock line for us is
   * what shows the server still has this choice open.
   */
  unconfirmed: { choice: string; rqid: number | null; turn: number; resends: number } | null;
  pendingDelivery: number | null;
  choiceDeliveryFailures: number;
  noLegalRetries: number;
  ambiguousPopups: number;
  noLegalRetryLogged: boolean;
  prediction: PredictionLog;
  assignment: BattleAssignment | null;
  requestTimer?: NodeJS.Timeout;
  finalizeTimer?: NodeJS.Timeout;
  deliveryTimer?: NodeJS.Timeout;
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
  runId?: string;
  batchLabel?: string | null;
  hostname?: string;
  localServer?: boolean;
  /** Delay between choice-delivery retries. Tests use a few milliseconds. */
  deliveryRetryMs?: number;
  /**
   * Unused. Waiting on the opponent is not a dropped choice, so silence does
   * not resend `/choose`. Kept so older callers still type-check.
   */
  choiceWatchMs?: number;
  /** How long to wait for a replay popup. Tests use 0. */
  settleMs?: number;
  /**
   * Config for this battle. Absent keeps the process config.
   * The same driver, timer, and choice watchdog serve every config.
   */
  routeBattle?: (battleId: string) => BattleAssignment;
  onBattleFault?: (battleId: string, fault: 'invalid-move' | 'crash') => void;
  onGame?: (record: LadderGameRecord) => void;
  /**
   * Replaces SetInference when this battle's config id is `calibrated`.
   * Ignored for the champion and the default, which stay on BeliefTracker.
   */
  posteriorFactory?: OpponentTrackerOptions['posteriorFactory'];
}

export interface BattleAssignment {
  configId: string;
  configHash: string;
  configPath: string | null;
  role: 'champion' | 'challenger';
  share: number;
  engine: EngineName;
}

const DELIVERY_ATTEMPTS = 3;
/** Clock ticks that still show our choice is open. A 150s turn can tick several times. */
const WATCHDOG_RESENDS = 20;

/**
 * The first `/choose` already stands, or the turn moved on. A second choose
 * is a new decision: Showdown rejects it, and a replacement would undo a
 * choice the server kept.
 */
function choiceAlreadyLocked(reason: string): boolean {
  return /too late|can'?t undo|nothing to choose|not your turn|nothing to cancel/i.test(reason);
}

/**
 * One user's battle loop: protocol state, request reconciliation,
 * champion decisions, and JSONL records. Never sends /forfeit.
 */
export class BattleDriver extends EventEmitter {
  private readonly rooms = new Map<string, RoomState>();
  private readonly quickWinPaths = new Map<string, boolean>();
  private readonly enrichPaths = new Map<string, boolean>();
  /** Room ids that already wrote a result. Later lines must not open them again. */
  private readonly closedRooms = new Set<string>();
  /** `setInference.id` for a config file. Null means the legacy tracker. */
  private readonly inferenceIds = new Map<string, string | null>();
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
    if (typeof clock === 'number') this.noteTimerMargin(room, clock);
    this.noteProtocol(room, line);
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
      this.applyRoomRating(room, rating);
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

    const rejected = invalidChoiceReason(line);
    if (rejected) {
      this.options.onBattleFault?.(room.roomId, 'invalid-move');
      this.noteInvalidChoice(room, rejected, line);
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

  /** `calibrated` opts into the posterior. A missing file or any other id stays legacy. */
  private setInferenceId(configPath: string | null): string | null {
    if (!configPath) return null;
    const cached = this.inferenceIds.get(configPath);
    if (cached !== undefined) return cached;
    let id: string | null = null;
    try {
      id = loadConfig(configPath).config.opponentModel.setInference.id;
    } catch {
      id = null;
    }
    this.inferenceIds.set(configPath, id);
    return id;
  }

  private openRoom(roomId: string): RoomState {
    const battle = new Battle(this.gens);
    const assignment = this.options.routeBattle?.(roomId) ?? null;
    const configPath = assignment ? assignment.configPath : (this.options.configPath ?? null);
    const log = openGameLog(this.options.logDir, `${toID(this.options.username)}-${roomId}`);
    const tracker = new OpponentTracker(this.options.format, () => this.rooms.get(roomId)?.ourSide ?? null, {
      setInference: this.setInferenceId(configPath),
      onBeliefError: (err, beliefErrors) => {
        log.write({
          type: 'belief_error',
          battleId: roomId,
          message: safeError(err),
          beliefErrors,
        });
      },
      posteriorFactory: this.options.posteriorFactory,
    });
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
      invalidChoiceReasons: [],
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
      prediction: new PredictionLog(),
      assignment,
    };
    this.rooms.set(roomId, room);
    claimBattle(this.options.logDir, roomId);
    this.options.client.trackRoom(roomId);
    this.options.decisions.openBattle(
      roomId,
      assignment ? { configPath: assignment.configPath, engine: assignment.engine } : undefined,
    );
    log.write({
      type: 'game_start',
      battleId: roomId,
      format: this.options.format.id,
      username: this.options.username,
      engine: assignment?.engine ?? this.options.engineName,
      ...(assignment ? {
        configId: assignment.configId,
        role: assignment.role,
        share: assignment.share,
      } : {}),
    });
    this.emit('battleStart', roomId, assignment);
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

    const enrich = this.usesEnrichment(room);
    const legal = legalActionsForRequest(request, this.options.format, {
      tera: this.usesQuickWins(room) || enrich,
    });
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
      this.markCrash(room, safeError(err));
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
      this.markCrash(room, safeError(err));
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
    if (typeof room.secondsLeft === 'number') this.noteTimerMargin(room, room.secondsLeft);
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

    const safe = sanitizeAction(decision.action, request, legal, { enrich }) ?? pickBestLegal(state, legal);
    const adjusted = !sameAction(safe, decision.action);
    if (decision.fallback || adjusted) room.fallbacks += 1;

    const choice = formatChoice(safe, rqid ?? undefined);
    room.mismatchCount += mismatches.length;
    this.emit('decision', {
      battleId: room.roomId,
      turn: state.turn,
      latencyMs,
      secondsLeft: room.secondsLeft,
      fallback: decision.fallback || adjusted,
    });
    // Send before any prediction or log write. A logging failure must not skip the choice.
    this.sendChoice(room, choice, rqid, safe, false);
    this.recordTurn(room, {
      request,
      position,
      stateTurn: state.turn,
      rqid,
      safe,
      choice,
      simChoice: formatChoice(safe),
      score: decision.score,
      searchMs: decision.timeMs,
      latencyMs,
      fallback: Boolean(decision.fallback || adjusted),
      fallbackReason: decision.reason || (adjusted ? 'removed an illegal modifier from the engine choice' : 'fallback'),
      adjusted: Boolean(decision.fallback || adjusted),
      mismatches: mismatchData(mismatches),
      roles,
      legalCount: legal.length,
    });
  }

  private noteProtocol(room: RoomState, line: string): void {
    try {
      const score = room.prediction.observe(line);
      if (score) this.writeScore(room, score);
    } catch {
      // Protocol parsing must not drop the line or the choice.
    }
  }

  private writeScore(room: RoomState, score: PredictionScore): void {
    try {
      room.log.write({
        type: 'prediction_error',
        battleId: room.roomId,
        engine: this.options.engineName,
        ...score,
      });
    } catch {
      // The choice is already in, or this line is only a record.
    }
  }

  private recordTurn(room: RoomState, input: {
    request: any;
    position: LivePosition;
    stateTurn: number;
    rqid: number | null;
    safe: Action;
    choice: string;
    simChoice: string;
    score: number | null;
    searchMs: number;
    latencyMs: number;
    fallback: boolean;
    fallbackReason: string;
    adjusted: boolean;
    mismatches: ReturnType<typeof mismatchData>;
    roles: Array<{ role: string; probability: number }>;
    legalCount: number;
  }): void {
    try {
      if (input.adjusted) {
        room.log.write({
          type: 'fallback',
          battleId: room.roomId,
          turn: input.stateTurn,
          rqid: input.rqid,
          reason: input.fallbackReason,
          action: input.safe,
        });
      }
      const prediction = this.forecastSafe(room, input.position, input.simChoice);
      const baseline = prediction && (room.ourSide === 'p1' || room.ourSide === 'p2')
        ? {
          ourSide: room.ourSide,
          ourHpBefore: ourHpFromRequest(input.request),
          foeHpBefore: foeHpFrom(input.position),
        }
        : null;
      room.log.write({
        type: 'turn',
        kind: 'turn',
        battleId: room.roomId,
        turn: input.stateTurn,
        rqid: input.rqid,
        decision: input.safe,
        choice: input.choice,
        score: input.score,
        searchMs: input.searchMs,
        latencyMs: input.latencyMs,
        fallback: input.fallback,
        mismatches: input.mismatches,
        opponentRoles: input.roles,
        legalCount: input.legalCount,
        secondsLeft: room.secondsLeft,
        engine: this.options.engineName,
        prediction,
        predictionBaseline: baseline,
      });
      if (prediction && baseline) {
        const previous = room.prediction.start({
          forecast: prediction,
          baseline,
          turn: input.stateTurn,
          rqid: input.rqid,
        });
        if (previous) this.writeScore(room, previous);
      }
    } catch {
      // Already sent. A forecast or disk failure stays off the turn.
    }
  }

  private usesQuickWins(room: RoomState): boolean {
    const file = room.assignment?.configPath;
    if (!file) return false;
    const cached = this.quickWinPaths.get(file);
    if (cached !== undefined) return cached;
    let quickWins = false;
    try {
      quickWins = loadConfig(file).config.search.id === QUICK_WIN_SEARCH_ID;
    } catch {
      quickWins = false;
    }
    this.quickWinPaths.set(file, quickWins);
    return quickWins;
  }

  private usesEnrichment(room: RoomState): boolean {
    if (usesDecisionEnrichment({ engine: this.options.engineName })) return true;
    const file = room.assignment?.configPath;
    if (!file) return false;
    const cached = this.enrichPaths.get(file);
    if (cached !== undefined) return cached;
    let enrich = false;
    try {
      const config = loadConfig(file).config;
      enrich = usesDecisionEnrichment({
        searchId: config.search.id,
        enrichDecisionState: config.hybrid?.params.enrichDecisionState,
      });
    } catch {
      enrich = false;
    }
    this.enrichPaths.set(file, enrich);
    return enrich;
  }

  private forecastSafe(room: RoomState, position: LivePosition, choice: string): TurnForecast | null {
    try {
      const quickWins = this.usesQuickWins(room);
      const battle = buildDecisionBattle(position, { quickWins, enrich: this.usesEnrichment(room) });
      if (!battle) return null;
      let config: ExactConfig = quickWins ? { ...EXACT_1PLY_QW, samples: 1 } : { ...EXACT_1PLY, samples: 1 };
      if (!quickWins) {
        try {
          const spec = ladderPolicy(parseEngine(this.options.engineName));
          if (spec.kind === 'exact') config = spec.config;
        } catch {
          // An unknown engine name still gets the champion's foe model, one draw.
        }
      }
      return forecastLine(battle, 'p1', choice, config);
    } catch {
      return null;
    }
  }

  private livePosition(room: RoomState, request: any): LivePosition {
    const enrich = this.usesEnrichment(room);
    return livePositionFromClient(
      room.battle,
      request,
      room.ourSide === 'p2' ? 'p2' : 'p1',
      enrich ? room.lines : undefined,
      { enrich },
    );
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
      const message = `send failed: ${safeError(err)}`;
      this.markCrash(room, message);
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
   * A clock line for us arrived after `/choose`. The server only sends that
   * while this player is still choosing, so the same choice and rqid go out
   * again. Silence is not this case: the opponent may simply be deciding.
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
  }

  private noteInvalidChoice(room: RoomState, reason: string, line: string): void {
    room.invalidChoices += 1;
    room.invalidChoiceReasons = cappedInvalidChoiceReasons([...room.invalidChoiceReasons, reason]);
    room.log.write({
      type: 'error',
      battleId: room.roomId,
      invalidChoice: true,
      message: line,
      reason,
    });
    this.dropUnconfirmed(room);
    if (choiceAlreadyLocked(reason)) {
      const rqid = typeof room.lastRequest?.rqid === 'number' ? room.lastRequest.rqid : null;
      room.log.write({
        type: 'choice-delivery',
        kind: 'choice-delivery',
        battleId: room.roomId,
        intendedRoomId: room.roomId,
        sentRoomId: null,
        rqid,
        choice: room.lastChoiceText,
        sent: false,
        cause: /not your turn/i.test(reason) ? 'not-your-turn' : 'server-rejected',
        serverLine: line,
        retry: room.retries,
        replacement: null,
      });
      return;
    }
    void this.retryChoice(room, line);
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
    room.fallbacks += 1;
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

  private markCrash(room: RoomState, message: string): void {
    room.crashes += 1;
    room.log.write({ type: 'crash', kind: 'crash', battleId: room.roomId, message });
    this.options.onBattleFault?.(room.roomId, 'crash');
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
    const rating = parseRatingLine(message);
    if (rating && attribution.attribution === 'matched') this.applyRoomRating(target, rating);
    const replay = parseReplayUrl(message);
    if (replay && replayMatchesRoom(target.roomId, replay.id)) target.replay = replay;
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

  private noteTimerMargin(room: RoomState, seconds: number): void {
    if (!Number.isFinite(seconds)) return;
    room.minTimerMarginSec = room.minTimerMarginSec === null
      ? seconds
      : Math.min(room.minTimerMarginSec, seconds);
  }

  /**
   * A rating stays on this battle only. A line already in the room is that
   * battle's. A popup counts only when its text names the room. A bare popup,
   * a `rating` event, or `/rank` does not pick a room.
   * Once the result is known, a win must rise and a loss must fall, or this
   * update is ignored so a later line for this room can still match.
   */
  private applyRoomRating(room: RoomState, rating: RatingUpdate): void {
    if (rating.after === null || !Number.isFinite(rating.after)) return;
    if (rating.username && toID(rating.username) !== toID(this.options.username)) return;
    if (room.finalized) return;
    if (room.ended && !this.ratingMatchesResult(room, rating.before, rating.after)) return;
    room.elo = {
      before: rating.before,
      after: rating.after,
      gxe: rating.gxe,
      gxeSource: rating.gxeSource,
    };
    if (rating.gxe !== null) room.gxe = rating.gxe;
  }

  private ratingMatchesResult(room: RoomState, before: number | null, after: number | null): boolean {
    if (before === null || after === null || !Number.isFinite(before) || !Number.isFinite(after)) return false;
    const outcome = classifyEnd({
      lines: room.lines,
      winner: room.winner,
      username: this.options.username,
      disconnected: room.disconnected,
    }).outcome;
    return eloDeltaConsistent(outcome, before, after) && (outcome === 'tie' || before !== after);
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
    const preRating = room.ourSide ? room.preRating[room.ourSide] ?? null : null;
    const eloBefore = room.elo?.before ?? null;
    const eloAfter = room.elo?.after ?? null;
    const replayDir = this.options.replayDir ?? path.join(this.options.logDir, 'replays');
    fs.mkdirSync(replayDir, { recursive: true });
    const localReplayPath = path.join(
      replayDir,
      `${toID(this.options.username)}-${room.roomId.replace(/[^a-zA-Z0-9_-]+/g, '_')}.log`,
    );
    fs.writeFileSync(localReplayPath, room.lines.join('\n'));
    this.replayFromLines(room);

    let calibration = null;
    try {
      const pending = room.prediction.close();
      if (pending) this.writeScore(room, pending);
      calibration = room.prediction.summary();
    } catch {
      calibration = null;
    }

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
      invalidChoiceReasons: room.invalidChoiceReasons,
      crashes: room.crashes,
      fallbacks: room.fallbacks,
      mismatches: room.mismatchCount,
      beliefErrors: room.tracker.beliefErrors(),
      eloBefore,
      eloAfter,
      preRating,
      gxe: room.gxe,
      latencies: room.latencies,
      minTimerMarginSec: room.minTimerMarginSec,
      engine: room.assignment?.engine ?? this.options.engineName,
      ourSide: room.ourSide,
      configId: room.assignment?.configId ?? this.options.configId ?? null,
      configHash: room.assignment?.configHash ?? this.options.configHash ?? null,
      gitSha: this.options.gitSha ?? null,
      runId: this.options.runId,
      batchLabel: this.options.batchLabel,
      hostname: this.options.hostname,
      configPath: room.assignment?.configPath ?? this.options.configPath ?? undefined,
      role: room.assignment?.role,
      share: room.assignment?.share,
      concurrency: this.options.concurrency ?? 1,
      replayId: room.replay?.id ?? null,
      replayUrl: room.replay?.url ?? null,
      localReplayPath,
      localServer: this.options.localServer ?? false,
      disconnected: room.disconnected,
      logPath: room.log.filePath,
      calibration,
    });
    let summary: GameSummary = {
      ...record,
      choiceDeliveryFailures: room.choiceDeliveryFailures,
      noLegalRetries: room.noLegalRetries,
      ambiguousPopups: room.ambiguousPopups,
    };
    const appended = appendGameRecord(this.options.logDir, summary);
    if (appended.reason === 'non-owning-process' || appended.reason === 'conflicting-result') {
      summary = { ...summary, contaminated: true, contaminationReason: appended.reason };
    }

    room.log.write({
      type: 'result',
      ...summary,
      gxeSource: room.elo?.gxeSource ?? 'missing',
    });
    this.options.onGame?.(summary);
    this.options.decisions.closeBattle(room.roomId);
    await room.log.close();
    this.options.client.untrackRoom(room.roomId);
    room.lines = [];
    this.rooms.delete(room.roomId);
    this.emit('gameEnd', summary);
  }
}
