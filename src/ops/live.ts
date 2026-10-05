import * as fs from 'fs';
import { LadderSession } from '../config/adapters.js';
import { buildBot } from '../config/bot.js';
import { resolveConcurrencyLimit } from '../client/concurrency-config.js';
import { ShowdownClient } from '../client/showdown-client.js';
import { allocate, nextCircuit, type Allocatable, type CircuitState, clampExplore } from './allocate.js';
import { openDb } from './db.js';
import { beat } from './heartbeat.js';
import { readLabels } from './labels-read.js';
import { appendJsonl, readJsonl, type OpsPaths } from './paths.js';
import { inputLogFromTranscript, localSimBridge } from './sim-bridge.js';
import { countsFromLiveGames, loadVariantPool, observeVariant, thompsonDraw, type ArmCount } from './variants.js';

export interface LiveOptions {
  paths: OpsPaths;
  local?: boolean;
  server?: string;
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
}

export interface LiveSummary {
  games: number;
  rating?: number;
  gxe?: number;
  skipped?: string;
}

interface LiveGameRecord {
  kind: 'live-game';
  id: string;
  ts: number;
  configId: string;
  configPath: string;
  /** Thompson arm for this game. Absent when the variant pool is empty. */
  variantId?: string;
  winner: 'win' | 'loss' | 'tie';
  rating: number;
  gxe: number;
  inputLog: string;
  log: string;
}

interface Seat {
  config: Allocatable;
  variantId: string | null;
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

  const local = Boolean(opts.local);
  const username = opts.username || process.env.SHOWDOWN_USERNAME || (local ? 'localbot' : '');
  const password = opts.password || process.env.SHOWDOWN_PASSWORD || '';
  if (!username || (!local && !password)) {
    const skipped = 'missing SHOWDOWN_USERNAME or SHOWDOWN_PASSWORD';
    beat(paths, 'live', 'error', skipped);
    return { games: 0, skipped };
  }

  const target = opts.games ?? (opts.once ? 1 : Number.POSITIVE_INFINITY);
  const slots = liveSlotLimit(opts);
  const exploreRate = clampExplore(opts.exploreRate ?? 0.15);
  const limits = { maxLosses: opts.maxLosses ?? 5, maxDrop: opts.maxDrop ?? 40, window: opts.window ?? 10 };
  const circuits = readCircuits(paths);
  const variantPool = loadVariantPool(paths);
  const variantCounts: Record<string, ArmCount> = countsFromLiveGames(readJsonl<LiveGameRecord>(paths.liveGames));
  process.env.JEV_LOG_DIR = paths.root;

  const server = opts.server || (local
    ? 'ws://127.0.0.1:8000/showdown/websocket'
    : 'wss://sim3.psim.us/showdown/websocket');
  const client = new ShowdownClient({
    server,
    username,
    password,
    format: 'gen9randombattle',
    local,
  });

  let rating: number | undefined;
  let gxe: number | undefined;
  let finished = 0;
  let active = 0;
  const pending: Seat[] = [];
  const sessions = new Map<string, { config: Allocatable; variantId: string | null; session: LadderSession }>();
  const transcripts = new Map<string, string[]>();
  const sides = new Map<string, 'p1' | 'p2'>();

  const timeoutMs = opts.timeoutMs ?? 120_000;
  const summary = await new Promise<LiveSummary>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.disconnect();
      reject(new Error(`live timed out after ${finished} games`));
    }, timeoutMs);
    const finish = (value: LiveSummary) => {
      clearTimeout(timer);
      resolve(value);
    };
    const launch = () => {
      while (active < slots && finished + active < target) {
        const config = allocate(withPulls(approved, circuits), Math.random, exploreRate);
        if (!config) {
          if (active === 0) finish({ games: finished, rating, gxe, skipped: 'every approved config is pulled' });
          return;
        }
        const variantId = thompsonDraw(variantPool, variantCounts, Math.random);
        pending.push({ config, variantId });
        active += 1;
        client.search();
      }
    };

    const transcript = (room: string) => (transcripts.get(room) || []).join('\n');

    client.on('rating', (update: { after?: number; rating?: number; gxe?: number }) => {
      if (typeof update.after === 'number') rating = update.after;
      if (typeof update.rating === 'number') rating = update.rating;
      if (typeof update.gxe === 'number') gxe = update.gxe;
    });

    client.on('line', (room: string, line: string) => {
      if (room) {
        const bucket = transcripts.get(room) || [];
        bucket.push(line);
        transcripts.set(room, bucket);
      }
      if (line.startsWith('|rating|')) {
        const parts = line.split('|');
        if (parts[2]) rating = Number(parts[2]);
        if (parts[3]) gxe = Number(parts[3]);
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
      const side = request.side?.id === 'p2' ? 'p2' : request.side?.id === 'p1' ? 'p1' : sides.get(room) ?? 'p1';
      if (side === 'p1' || side === 'p2') sides.set(room, side);
      let current = sessions.get(room);
      if (!current) {
        const seat = pending.shift();
        if (!seat) return;
        const bot = buildBot(seat.config.configPath, local ? 'local' : 'ladder');
        current = {
          config: seat.config,
          variantId: seat.variantId,
          session: new LadderSession(bot, local ? localSimBridge : undefined, seat.variantId ?? undefined),
        };
        sessions.set(room, current);
      }
      void current.session.onRequest(room, request, transcript(room), side).then(choice => {
        client.choose(room, choice);
      }).catch(error => {
        beat(paths, 'live', 'error', error instanceof Error ? error.message : String(error));
      });
    });

    client.on('battleEndLine', (room: string, line: string) => {
      const winner = line.startsWith('|win|') ? line.slice('|win|'.length).trim() : null;
      const current = sessions.get(room);
      sessions.delete(room);
      active = Math.max(0, active - 1);
      finished += 1;
      if (current) {
        const outcome = classify(winner, username);
        const record: LiveGameRecord = {
          kind: 'live-game',
          id: `${room}-${Date.now()}`,
          ts: Date.now(),
          configId: current.config.configId,
          configPath: current.config.configPath,
          winner: outcome,
          rating: rating ?? 1000,
          gxe: gxe ?? 50,
          inputLog: inputLogFromTranscript(transcript(room)) || '',
          log: transcript(room).slice(-6000),
        };
        if (current.variantId) record.variantId = current.variantId;
        appendJsonl(paths.liveGames, record);
        observeVariant(variantCounts, current.variantId, outcome);
        circuits[current.config.configId] = nextCircuit(circuits[current.config.configId], outcome, record.rating, limits);
        writeCircuits(paths, circuits);
        beat(paths, 'live', 'ok', `${current.config.configId} ${outcome} rating ${record.rating}`);
      }
      if (finished >= target) {
        finish({ games: finished, rating, gxe });
        return;
      }
      launch();
    });

    client.connect().then(() => {
      beat(paths, 'live', 'ok', `logged in ${username}`);
      launch();
    }).catch(error => {
      beat(paths, 'live', 'error', error instanceof Error ? error.message : String(error));
      reject(error);
    });
  });

  client.disconnect();
  beat(paths, 'live', 'stopped', `games ${summary.games}`);
  return summary;
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

function withPulls(configs: Allocatable[], circuits: Record<string, CircuitState>): Allocatable[] {
  return configs.map(config => ({ ...config, pulled: circuits[config.configId]?.pulled }));
}

function classify(winner: string | null, username: string): 'win' | 'loss' | 'tie' {
  if (!winner) return 'tie';
  const strip = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return strip(winner) === strip(username) ? 'win' : 'loss';
}

function readCircuits(paths: OpsPaths): Record<string, CircuitState> {
  if (!fs.existsSync(paths.circuits)) return {};
  return JSON.parse(fs.readFileSync(paths.circuits, 'utf8')) as Record<string, CircuitState>;
}

function writeCircuits(paths: OpsPaths, circuits: Record<string, CircuitState>): void {
  fs.writeFileSync(paths.circuits, JSON.stringify(circuits, null, 2));
}
