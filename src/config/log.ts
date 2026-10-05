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

function logDir(): string {
  return process.env.JEV_LOG_DIR || path.join(process.cwd(), 'state');
}

export function createLogger(env: EnvProfile): DecisionLogger {
  const decisions: DecisionLogRecord[] = [];
  const games: GameLogRecord[] = [];
  const persist = env.logSink !== 'memory';
  return {
    decision(record) {
      decisions.push(record);
      if (persist) append('decisions.jsonl', record);
    },
    game(record) {
      games.push(record);
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
