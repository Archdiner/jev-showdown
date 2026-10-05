import * as fs from 'fs';
import * as path from 'path';
import type { EnvProfile } from './env.js';
import type { LayerIds } from './interfaces.js';

export interface DecisionLogRecord {
  ts: number;
  kind: 'decision';
  configId: string;
  layerIds: LayerIds;
  activeLayerIds: LayerIds;
  env: string;
  gameId?: string;
  seed?: number;
  turn: number;
  side: string;
  choice: string;
  scores: Array<{ choice: string; score: number }>;
  ms: number;
  advisorCalled: boolean;
  overBudget: boolean;
  variantId?: string;
}

export interface GameLogRecord {
  ts: number;
  kind: 'game';
  gameId: string;
  seed: number;
  configId: string;
  layerIds: LayerIds;
  env: string;
  opponentConfigId?: string;
  winner?: string;
  turns?: number;
  invalid?: number;
  situations?: Record<string, number | boolean>;
}

export interface DecisionLogger {
  decision(record: DecisionLogRecord): void;
  game(record: GameLogRecord): void;
  decisions(): DecisionLogRecord[];
  games(): GameLogRecord[];
}

/** In-memory window. JSONL still receives every row when the sink persists. */
export const LOGGER_DECISION_CAP = 2000;
export const LOGGER_GAME_CAP = 500;

function logDir(): string {
  return process.env.JEV_LOG_DIR || path.join(process.cwd(), 'state');
}

function remember<T>(bucket: T[], record: T, cap: number): void {
  bucket.push(record);
  if (bucket.length > cap) bucket.splice(0, bucket.length - cap);
}

export function createLogger(env: EnvProfile): DecisionLogger {
  const decisions: DecisionLogRecord[] = [];
  const games: GameLogRecord[] = [];
  const persist = env.logSink !== 'memory';
  return {
    decision(record) {
      remember(decisions, record, LOGGER_DECISION_CAP);
      if (persist) append('decisions.jsonl', record);
    },
    game(record) {
      remember(games, record, LOGGER_GAME_CAP);
      if (persist) append('games.jsonl', record);
    },
    decisions: () => decisions,
    games: () => games,
  };
}

function append(file: string, record: unknown): void {
  const dir = logDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, file), `${JSON.stringify(record)}\n`);
}
