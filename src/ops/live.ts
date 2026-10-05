import * as fs from 'fs';
import { LadderSession } from '../config/adapters.js';
import { buildBot } from '../config/bot.js';
import { ShowdownClient } from '../client/showdown-client.js';
import { allocate, nextCircuit, type Allocatable, type CircuitState, clampExplore } from './allocate.js';
import { openDb } from './db.js';
import { beat } from './heartbeat.js';
import { readLabels } from './labels-read.js';
import { appendJsonl, type OpsPaths } from './paths.js';
import { inputLogFromTranscript, localSimBridge } from './sim-bridge.js';

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
  winner: 'win' | 'loss' | 'tie';
  rating: number;
  gxe: number;
  inputLog: string;
  log: string;
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
  const slots = Math.max(1, (opts.runners ?? 1) * (opts.concurrency ?? 1));
  const exploreRate = clampExplore(opts.exploreRate ?? 0.15);
  const limits = { maxLosses: opts.maxLosses ?? 5, maxDrop: opts.maxDrop ?? 40, window: opts.window ?? 10 };
  const circuits = readCircuits(paths);
  process.env.JEV_LOG_DIR = paths.root;

  const client = new ShowdownClient({
    username,
    password,
    format: 'gen9randombattle',
    local,
    server: opts.server || (local ? 'ws://127.0.0.1:8000/showdown/websocket' : undefined),
  });

  let rating: number | undefined;
  let gxe: number | undefined;
  let finished = 0;
  let active = 0;
  const pending: Allocatable[] = [];
  const sessions = new Map<string, { config: Allocatable; session: LadderSession }>();

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
        pending.push(config);
        active += 1;
        client.searchBattle();
      }
    };

    client.on('rating', (update: { rating: number; gxe: number }) => {
      rating = update.rating;
      gxe = update.gxe;
    });

    client.on('request', (room: string, request: unknown) => {
      let current = sessions.get(room);
      if (!current) {
        const config = pending.shift();
        if (!config) return;
        const bot = buildBot(config.configPath, local ? 'local' : 'ladder');
        current = { config, session: new LadderSession(bot, local ? localSimBridge : undefined) };
        sessions.set(room, current);
      }
      const side = client.sideFor(room) ?? 'p1';
      void current.session.onRequest(room, request, client.transcript(room), side).then(choice => {
        client.choose(room, choice);
      }).catch(error => {
        beat(paths, 'live', 'error', error instanceof Error ? error.message : String(error));
      });
    });

    client.on('battleEnd', (room: string, winner: string | null) => {
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
          inputLog: inputLogFromTranscript(client.transcript(room)) || '',
          log: client.transcript(room).slice(-6000),
        };
        appendJsonl(paths.liveGames, record);
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
