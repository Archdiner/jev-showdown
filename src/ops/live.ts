import * as fs from 'fs';
import { fallbackChoice, LadderSession } from '../config/adapters.js';
import { buildBot } from '../config/bot.js';
import { resolveConcurrencyLimit } from '../client/concurrency-config.js';
import { buildLadderGameRecord, currentGitSha, factsFromTranscript } from '../client/game-record.js';
import { currentHostname, readBatchLabel } from '../client/run-stamp.js';
import {
  defaultLadderRunDirs,
  publicAccountConflict,
  readLadderRuns,
} from '../client/ladder-run.js';
import { LadderQueue } from '../client/ladder-queue.js';
import { parseRatingLine, ShowdownClient } from '../client/showdown-client.js';
import {
  allocate,
  baselineFromGames,
  emptyCircuitBook,
  noteOutcome,
  parseCircuitBook,
  releaseChampionPulls,
  selectionPool,
  type Allocatable,
  type CircuitBook,
  type CircuitLimits,
  type CircuitScope,
  type CircuitState,
  clampExplore,
} from './allocate.js';
import { startLocalServer, type LocalServer } from './local-server.js';
import { openDb } from './db.js';
import { beat } from './heartbeat.js';
import { readLabels, readSupersededChampions } from './labels-read.js';
import { appendJsonl, readJsonl, type OpsPaths } from './paths.js';
import { inputLogFromTranscript, localSimBridge } from './sim-bridge.js';
import { countsFromLiveGames, loadVariantPool, observeVariant, thompsonDraw, type ArmCount } from './variants.js';

type Seat = 'p1' | 'p2';

/**
 * Seat used to answer a request. When the request and the remembered player line
 * both omit the seat, the choice is still p1 so a move goes out. That guess is
 * not persisted, so later priors do not treat it as our side.
 */
export function seatForChoice(
  requested: string | undefined,
  remembered: Seat | undefined,
): { choice: Seat; persist: Seat | null } {
  const known = requested === 'p1' || requested === 'p2' ? requested : remembered ?? null;
  return { choice: known ?? 'p1', persist: known };
}

export interface LiveOptions {
  paths: OpsPaths;
  local?: boolean;
  server?: string;
  /** TCP port for the local server this process starts. 0 picks a free port. */
  port?: number;
  games?: number;
  runners?: number;
  concurrency?: number;
  username?: string;
  password?: string;
  exploreRate?: number;
  maxLosses?: number;
  maxDrop?: number;
  window?: number;
  once?: boolean;
  timeoutMs?: number;
  /** Directories of ladder.ts run files. Tests pass one temp dir. */
  ladderRunDirs?: string[];
}

export const PUBLIC_WEBSOCKET = 'wss://sim3.psim.us/showdown/websocket';
const PUBLIC_LOGIN_SERVER = 'https://play.pokemonshowdown.com/action.php';

export function isLoopbackWebSocket(server: string): boolean {
  try {
    const url = new URL(server);
    const host = url.hostname;
    return url.protocol === 'ws:' && (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]');
  } catch {
    return false;
  }
}

/**
 * Local play uses a guest name and an empty password, so ShowdownClient never
 * POSTs to the public login server. A loopback `--server` is local even when
 * the flag was omitted.
 */
export function resolveLiveIdentity(
  opts: Pick<LiveOptions, 'local' | 'server' | 'username' | 'password' | 'port'>,
  env: NodeJS.ProcessEnv = process.env,
): {
  local: boolean;
  username: string;
  password: string;
  server: string | null;
  port: number;
  loginServer?: string;
} {
  const loopback = Boolean(opts.server && isLoopbackWebSocket(opts.server));
  if (opts.local && opts.server && !loopback) {
    throw new Error('--local only talks to a loopback websocket. Omit --server to start one, or omit --local for the public ladder.');
  }
  const local = Boolean(opts.local) || loopback;
  if (local) {
    return {
      local: true,
      username: opts.username || 'localbot',
      password: '',
      server: opts.server || null,
      port: opts.port ?? 0,
      loginServer: 'http://127.0.0.1:9/unused',
    };
  }
  return {
    local: false,
    username: opts.username || env.SHOWDOWN_USERNAME || '',
    password: opts.password ?? env.SHOWDOWN_PASSWORD ?? '',
    server: opts.server || PUBLIC_WEBSOCKET,
    port: 0,
    loginServer: env.SHOWDOWN_LOGIN_URL || PUBLIC_LOGIN_SERVER,
  };
}

export interface LiveSummary {
  games: number;
  rating?: number;
  gxe?: number;
  skipped?: string;
}

interface RoomWatch {
  startedAt: number;
  latencies: number[];
}

export async function runLive(opts: LiveOptions): Promise<LiveSummary> {
  const paths = opts.paths;
  beat(paths, 'live', 'ok', 'up');
  const approved = approvedConfigs(paths);
  if (approved.length === 0) {
    const skipped = 'no gatekeeper-approved config';
    beat(paths, 'live', 'stopped', skipped);
    return { games: 0, skipped };
  }

  const identity = resolveLiveIdentity(opts);
  const local = identity.local;
  const username = identity.username;
  const password = identity.password;
  if (!username || (!local && !password)) {
    const skipped = 'missing SHOWDOWN_USERNAME or SHOWDOWN_PASSWORD';
    beat(paths, 'live', 'error', skipped);
    return { games: 0, skipped };
  }
  if (!local) {
    const dirs = opts.ladderRunDirs ?? defaultLadderRunDirs();
    const conflict = publicAccountConflict(username, dirs.flatMap(readLadderRuns));
    if (conflict?.action === 'refuse') {
      beat(paths, 'live', 'error', conflict.message);
      throw new Error(conflict.message);
    }
    if (conflict) {
      console.error(conflict.message);
      beat(paths, 'live', 'error', conflict.message);
    }
  }

  const target = opts.games ?? (opts.once ? 1 : Number.POSITIVE_INFINITY);
  const slots = liveSlotLimit(opts);
  const exploreRate = clampExplore(opts.exploreRate ?? 0.15);
  const limits: CircuitLimits = {
    maxLosses: opts.maxLosses,
    maxDrop: opts.maxDrop ?? 40,
    window: opts.window ?? 10,
  };
  const book = readCircuitBook(paths);
  const scope: CircuitScope = local ? 'local' : 'ladder';
  if (releaseChampionPulls(book[scope], approved)) writeCircuitBook(paths, book);
  const knownGood = knownGoodChampions(paths);
  const variantPool = loadVariantPool(paths);
  const variantCounts: Record<string, ArmCount> = countsFromLiveGames(readJsonl(paths.liveGames));
  const gitSha = currentGitSha();
  process.env.JEV_LOG_DIR = paths.root;

  let ownedServer: LocalServer | null = null;
  let server = identity.server;
  try {
  if (local && !server) {
    if (!Number.isInteger(identity.port) || identity.port < 0 || identity.port > 65535) {
      throw new Error('--port must be an integer from 0 to 65535');
    }
    try {
      ownedServer = await startLocalServer(identity.port);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not start the local server on port ${identity.port}: ${reason}`);
    }
    server = ownedServer.url;
  }
  if (!server) throw new Error('ops live has no server');
  const runId = `${Date.now()}`;
  const batchLabel = readBatchLabel();
  const hostname = currentHostname();
  beat(paths, 'live', 'ok', `${local ? 'local' : 'public'} ${server} user ${username} run ${runId}`);
  console.log(local
    ? `[ops live] ${server} username=${username} local=yes run=${runId}`
    : `[ops live] ${server} username=${username} local=no run=${runId}`);
  const client = new ShowdownClient({
    server,
    username,
    password,
    format: 'gen9randombattle',
    local,
    loginServer: identity.loginServer,
  });

  let rating: number | undefined;
  let gxe: number | undefined;
  const held: { rating?: number; gxe?: number } = {};
  let finished = 0;
  const sessions = new Map<string, { config: Allocatable; variantId: string | null; session: LadderSession }>();
  const transcripts = new Map<string, string[]>();
  const watches = new Map<string, RoomWatch>();
  const sides = new Map<string, 'p1' | 'p2'>();
  const started = new Set<string>();

  const timeoutMs = opts.timeoutMs ?? 120_000;
  const bounded = opts.once === true || (typeof opts.games === 'number' && Number.isFinite(opts.games));
  let queue!: LadderQueue;
  const pool = () => selectionPool(approved, book[scope], knownGood, Date.now());
  const hasOpenConfig = () => approved.length > 0 && allocate(pool(), () => 0, exploreRate) !== null;
  queue = new LadderQueue(
    client,
    'gen9randombattle',
    slots,
    message => beat(paths, 'live', 'error', message),
    true,
    () => finished + queue.activeBattles < target && hasOpenConfig(),
  );
  const summary = await new Promise<LiveSummary>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onTimeout = () => {
      if (queue.activeBattles > 0) {
        armTimeout();
        return;
      }
      queue.stop();
      client.disconnect();
      if (!bounded || finished > 0) {
        finish({ games: finished, rating, gxe, skipped: 'window' });
        return;
      }
      reject(new Error(`live timed out after ${finished} games`));
    };
    const armTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(onTimeout, timeoutMs);
    };
    timer = setTimeout(onTimeout, timeoutMs);
    const finish = (value: LiveSummary) => {
      clearTimeout(timer);
      queue.stop();
      resolve(value);
    };
    const maybeFill = () => {
      if (finished >= target) {
        finish({ games: finished, rating, gxe });
        return;
      }
      if (!hasOpenConfig() && queue.activeBattles === 0) {
        const skipped = 'every approved config is pulled';
        beat(paths, 'live', 'error', skipped);
        finish({ games: finished, rating, gxe, skipped });
        return;
      }
      queue.fill();
    };

    const transcript = (room: string) => (transcripts.get(room) || []).join('\n');

    client.on('popup', (message: string) => queue.notePopup(message));
    client.on('lobby', (line: string) => queue.noteLobby(line));

    client.on('rating', (update: { after?: number | null; rating?: number | null; gxe?: number | null }) => {
      rememberRating(held, update);
      rating = held.rating;
      gxe = held.gxe;
    });

    client.on('line', (room: string, line: string) => {
      if (room.startsWith('battle-') && !started.has(room)) {
        started.add(room);
        queue.noteBattle(room);
      }
      if (room) {
        const bucket = transcripts.get(room) || [];
        bucket.push(line);
        transcripts.set(room, bucket);
        if (!watches.has(room)) watches.set(room, { startedAt: Date.now(), latencies: [] });
      }
      const parsedRating = parseRatingLine(line);
      if (parsedRating) {
        rememberRating(held, parsedRating);
        rating = held.rating;
        gxe = held.gxe;
      }
      if (line.startsWith('|player|') && room) {
        const parts = line.split('|');
        const slot = parts[2];
        const name = (parts[3] || '').trim();
        if ((slot === 'p1' || slot === 'p2') && classify(name, username) === 'win') sides.set(room, slot);
      }
      if (!line.startsWith('|request|') || !room) return;
      let request: { side?: { id?: string } };
      try {
        request = JSON.parse(line.slice('|request|'.length));
      } catch {
        return;
      }
      const seat = seatForChoice(request.side?.id, sides.get(room));
      if (seat.persist) sides.set(room, seat.persist);
      const side = seat.choice;
      let current = sessions.get(room);
      if (!current) {
        const config = allocate(pool(), Math.random, exploreRate);
        if (!config) {
          const choice = fallbackChoice(request);
          if (choice) client.choose(room, choice);
          beat(paths, 'live', 'error', `choice-fallback ${room}`);
          return;
        }
        const variantId = thompsonDraw(variantPool, variantCounts, Math.random);
        const bot = buildBot(config.configPath, local ? 'local' : 'ladder');
        current = {
          config,
          variantId,
          session: new LadderSession(bot, local ? localSimBridge : undefined, variantId ?? undefined),
        };
        sessions.set(room, current);
      }
      const choiceStarted = Date.now();
      void current.session.onRequest(room, request, transcript(room), side).then(delivered => {
        const row = watches.get(room);
        if (row) row.latencies.push(Date.now() - choiceStarted);
        if (delivered.fallback) beat(paths, 'live', 'error', `choice-fallback ${room}`);
        if (delivered.choice) client.choose(room, delivered.choice);
      }).catch(error => {
        beat(paths, 'live', 'error', error instanceof Error ? error.message : String(error));
        const choice = fallbackChoice(request);
        if (choice) client.choose(room, choice);
      });
    });

    client.on('battleEndLine', (room: string, line: string) => {
      const winner = line.startsWith('|win|') ? line.slice('|win|'.length).trim() : null;
      const current = sessions.get(room);
      sessions.delete(room);
      queue.noteEnd(room);
      finished += 1;
      if (current) {
        const lines = transcripts.get(room) || [];
        const facts = factsFromTranscript(lines, username);
        const watched = watches.get(room);
        const text = lines.join('\n');
        const record = buildLadderGameRecord({
          startedAt: watched?.startedAt ?? Date.now(),
          battleId: room,
          format: 'gen9randombattle',
          username,
          opponent: facts.opponent,
          opponentRating: facts.opponentRating,
          lines,
          winner: facts.winner ?? winner,
          turns: facts.turns,
          invalidChoices: facts.invalidChoices,
          crashes: facts.crashes,
          fallbacks: 0,
          mismatches: 0,
          eloBefore: facts.eloBefore,
          eloAfter: facts.eloAfter,
          preRating: facts.preRating,
          gxe: facts.gxe,
          latencies: watched?.latencies ?? [],
          minTimerMarginSec: facts.minTimerMarginSec,
          engine: current.session.bot.layerIds.search,
          ourSide: sides.get(room) ?? facts.ourSide,
          configId: current.config.configId,
          configHash: current.session.bot.configId,
          gitSha,
          runId,
          batchLabel,
          hostname,
          concurrency: slots,
          replayId: facts.replayId,
          replayUrl: facts.replayUrl,
          localReplayPath: null,
          localServer: local,
          disconnected: false,
          logPath: paths.liveGames,
          source: 'ops',
          configPath: current.config.configPath,
          variantId: current.variantId ?? undefined,
          inputLog: inputLogFromTranscript(text) || '',
          log: text.slice(-6000),
        });
        appendJsonl(paths.liveGames, record);
        observeVariant(variantCounts, current.variantId, record.outcome);
        const role = current.config.labels.includes('champion') ? 'champion' : 'challenger';
        const updated = noteOutcome(
          book,
          scope,
          current.config.configId,
          record.outcome,
          record.eloAfter,
          {
            ...limits,
            role,
            baselineWinRate: baselineFromGames(scopedOutcomes(paths, current.config.configId, scope)),
            now: Date.now(),
          },
        );
        book.ladder = updated.ladder;
        book.local = updated.local;
        writeCircuitBook(paths, book);
        if (role === 'champion') {
          syncChampionRegression(paths, current.config, book[scope][current.config.configId]);
        }
        beat(paths, 'live', 'ok', local
          ? `${current.config.configId} ${record.outcome} local`
          : `${current.config.configId} ${record.outcome} rating ${record.eloAfter ?? 'n/a'}`);
      }
      transcripts.delete(room);
      watches.delete(room);
      maybeFill();
    });

    client.connect().then(() => {
      beat(paths, 'live', 'ok', `logged in ${username}`);
      maybeFill();
    }).catch(error => {
      beat(paths, 'live', 'error', error instanceof Error ? error.message : String(error));
      reject(error);
    });
  });

  queue.stop();
  client.disconnect();
  beat(paths, 'live', 'stopped', `games ${summary.games}`);
  return summary;
  } finally {
    if (ownedServer) await ownedServer.close();
  }
}

/**
 * One login, many approved configs, so this is not an engine profile.
 * `--concurrency` replaces the default of 1, `--runners` multiplies it, and the
 * result is clamped to the absolute max.
 */
export function liveSlotLimit(opts: { concurrency?: number; runners?: number }): number {
  return resolveConcurrencyLimit({
    engine: 'ops',
    useEngineProfile: false,
    concurrency: opts.concurrency ?? null,
    runners: opts.runners ?? null,
  }).limit;
}

function approvedConfigs(paths: OpsPaths): Allocatable[] {
  const db = openDb(paths);
  try {
    return readLabels(db).map(label => ({
      configId: label.configId,
      configPath: label.configPath,
      labels: label.labels,
    }));
  } finally {
    db.close();
  }
}

function knownGoodChampions(paths: OpsPaths): Allocatable[] {
  const db = openDb(paths);
  try {
    return readSupersededChampions(db).map(label => ({
      configId: label.configId,
      configPath: label.configPath,
      labels: label.labels,
    }));
  } finally {
    db.close();
  }
}

function scopedOutcomes(paths: OpsPaths, configId: string, scope: CircuitScope): Array<'win' | 'loss' | 'tie'> {
  const rows = readJsonl<{ configId?: string; outcome?: string; localServer?: boolean }>(paths.liveGames);
  const outcomes: Array<'win' | 'loss' | 'tie'> = [];
  for (const row of rows) {
    if (row.configId !== configId) continue;
    const localGame = row.localServer === true;
    if (scope === 'local' ? !localGame : localGame) continue;
    if (row.outcome === 'win' || row.outcome === 'loss' || row.outcome === 'tie') outcomes.push(row.outcome);
  }
  return outcomes;
}

/** A champion streak that is unlikely at the baseline becomes a regression node. A broken streak closes it. */
function syncChampionRegression(paths: OpsPaths, config: Allocatable, state: CircuitState | undefined): void {
  const db = openDb(paths);
  try {
    const id = `regression-circuit-${config.configId}`;
    const existing = db.getNode(id);
    const now = Date.now();
    if (state?.regression) {
      if (existing?.status === 'detected') return;
      db.addNode({
        id,
        type: 'Learning',
        status: 'detected',
        title: 'Champion loss streak',
        description: state.reason || 'champion streak',
        created_at: existing?.created_at ?? now,
        updated_at: now,
        insight: `${config.configId} is past the baseline loss streak. It stays playable.`,
        evidence: config.configPath,
        confidence: 'medium',
        metadata: { opsKind: 'regression', configId: config.configId, configPath: config.configPath, source: 'circuit' },
      });
      return;
    }
    if (!existing || existing.status !== 'detected' || existing.type !== 'Learning') return;
    db.addNode({
      ...existing,
      status: 'done',
      updated_at: now,
      insight: `${config.configId} streak ended. The config stays playable.`,
    });
  } finally {
    db.close();
  }
}

/** Keep the last real Elo. A rating update that omits GXE clears GXE instead of keeping a stale number. */
export function rememberRating(
  current: { rating?: number; gxe?: number },
  update: { after?: number | null; rating?: number | null; gxe?: number | null },
): void {
  if (typeof update.after === 'number' && Number.isFinite(update.after)) current.rating = update.after;
  else if (typeof update.rating === 'number' && Number.isFinite(update.rating)) current.rating = update.rating;
  if ('gxe' in update) {
    current.gxe = typeof update.gxe === 'number' && Number.isFinite(update.gxe) ? update.gxe : undefined;
  }
}

/** Null when the server omitted the number. Never 1000 or 50. */
export function recordedRating(
  rating: number | undefined,
  gxe: number | undefined,
): { rating: number | null; gxe: number | null } {
  return {
    rating: typeof rating === 'number' && Number.isFinite(rating) ? rating : null,
    gxe: typeof gxe === 'number' && Number.isFinite(gxe) ? gxe : null,
  };
}

function classify(winner: string | null, username: string): 'win' | 'loss' | 'tie' {
  if (!winner) return 'tie';
  const strip = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return strip(winner) === strip(username) ? 'win' : 'loss';
}

function readCircuitBook(paths: OpsPaths): CircuitBook {
  if (!fs.existsSync(paths.circuits)) return emptyCircuitBook();
  return parseCircuitBook(JSON.parse(fs.readFileSync(paths.circuits, 'utf8')) as unknown);
}

function writeCircuitBook(paths: OpsPaths, book: CircuitBook): void {
  fs.writeFileSync(paths.circuits, JSON.stringify(book, null, 2));
}
