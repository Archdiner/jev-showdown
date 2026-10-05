import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ENV_PROFILES } from './env.js';
import { createLogger, LOGGER_DECISION_CAP, LOGGER_GAME_CAP, type DecisionLogRecord, type GameLogRecord } from './log.js';

function decision(turn: number): DecisionLogRecord {
  return { turn, kind: 'decision' } as DecisionLogRecord;
}

function game(gameId: string): GameLogRecord {
  return { gameId, kind: 'game' } as GameLogRecord;
}

describe('createLogger memory cap', () => {
  const previous = process.env.JEV_LOG_DIR;

  afterEach(() => {
    if (previous === undefined) delete process.env.JEV_LOG_DIR;
    else process.env.JEV_LOG_DIR = previous;
  });

  it('keeps a bounded window in memory and every decision on disk', () => {
    const memory = createLogger(ENV_PROFILES.selfplay);
    for (let turn = 0; turn < LOGGER_DECISION_CAP + 3; turn += 1) memory.decision(decision(turn));
    expect(memory.decisions()).toHaveLength(LOGGER_DECISION_CAP);
    expect(memory.decisions()[0].turn).toBe(3);
    expect(memory.decisions().at(-1)?.turn).toBe(LOGGER_DECISION_CAP + 2);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-log-'));
    process.env.JEV_LOG_DIR = dir;
    const file = createLogger(ENV_PROFILES.ladder);
    for (let turn = 0; turn < LOGGER_DECISION_CAP + 3; turn += 1) file.decision(decision(turn));
    for (let index = 0; index < LOGGER_GAME_CAP + 2; index += 1) file.game(game(`g${index}`));
    expect(file.decisions()).toHaveLength(LOGGER_DECISION_CAP);
    expect(file.games()).toHaveLength(LOGGER_GAME_CAP);
    expect(file.games()[0].gameId).toBe('g2');
    const lines = fs.readFileSync(path.join(dir, 'decisions.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(LOGGER_DECISION_CAP + 3);
    const games = fs.readFileSync(path.join(dir, 'games.jsonl'), 'utf8').trim().split('\n');
    expect(games).toHaveLength(LOGGER_GAME_CAP + 2);
  });
});
