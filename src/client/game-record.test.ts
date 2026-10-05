import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import {
  appendGameRecord,
  buildLadderGameRecord,
  classifyEnd,
  configHash,
  currentGitSha,
  factsFromTranscript,
  gxeOf,
  latencyFields,
  percentile,
  replayIdFromBattle,
  toOpsLiveGame,
  LadderGameInput,
} from './game-record.js';
import { BattleDriver } from './battle-driver.js';
import { DecisionClient } from './decision-client.js';
import { ShowdownClient } from './showdown-client.js';
import { dataLoader } from '../data/data-loader.js';
import { gen9RandomBattle } from '../formats/gen9-randombattle.js';

function input(extra: Partial<LadderGameInput> = {}): LadderGameInput {
  return {
    ts: 1_000_000,
    startedAt: 1_000_000 - 21_000,
    battleId: 'battle-gen9randombattle-1',
    format: 'gen9randombattle',
    username: 'BotAlpha',
    opponent: 'Rival',
    opponentRating: 1400,
    lines: ['|win|BotAlpha'],
    winner: 'BotAlpha',
    turns: 21,
    invalidChoices: 0,
    crashes: 0,
    fallbacks: 0,
    mismatches: 0,
    eloBefore: 1073,
    eloAfter: 1089,
    gxe: null,
    latencies: [10, 20, 30, 40],
    minTimerMarginSec: 12,
    engine: 'max-damage',
    configId: null,
    configHash: 'abc',
    gitSha: '87b268f',
    concurrency: 2,
    replayId: null,
    replayUrl: null,
    localReplayPath: '/tmp/replay.log',
    localServer: false,
    disconnected: false,
    logPath: '/tmp/game.jsonl',
    pid: 7,
    ...extra,
  };
}

describe('ladder game records', () => {
  it('classifies KO, forfeit, timer, disconnect, and crash', () => {
    expect(classifyEnd({ lines: ['|win|Rival'], winner: 'Rival', username: 'BotAlpha' })).toEqual({
      outcome: 'loss',
      endReason: 'ko',
    });
    expect(classifyEnd({
      lines: ['|-message|Rival forfeited.', '|win|BotAlpha'],
      winner: 'BotAlpha',
      username: 'BotAlpha',
    })).toEqual({ outcome: 'win', endReason: 'opponent-forfeit' });
    expect(classifyEnd({
      lines: ['|-message|Bot Alpha forfeited.', '|win|Rival'],
      winner: 'Rival',
      username: 'Bot Alpha',
    })).toEqual({ outcome: 'loss', endReason: 'our-forfeit' });
    expect(classifyEnd({
      lines: ['|-message|BotAlpha lost due to inactivity.', '|win|Rival'],
      winner: 'Rival',
      username: 'BotAlpha',
    })).toEqual({ outcome: 'loss', endReason: 'our-timer' });
    expect(classifyEnd({
      lines: ['|-message|Rival lost due to inactivity.', '|win|BotAlpha'],
      winner: 'BotAlpha',
      username: 'BotAlpha',
    })).toEqual({ outcome: 'win', endReason: 'opponent-timer' });
    expect(classifyEnd({
      lines: ['|bigerror|The simulator process crashed.'],
      winner: null,
      username: 'BotAlpha',
    })).toEqual({ outcome: 'tie', endReason: 'crash' });
    expect(classifyEnd({
      lines: [],
      winner: null,
      username: 'BotAlpha',
      disconnected: true,
    })).toEqual({ outcome: 'tie', endReason: 'disconnect' });
    expect(classifyEnd({ lines: ['|tie'], winner: null, username: 'BotAlpha' })).toEqual({
      outcome: 'tie',
      endReason: 'tie',
    });
  });

  it('summarizes decision latency with the live-metrics percentile names', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
    expect(latencyFields([], null)).toEqual({
      decisions: 0,
      latencyP50Ms: null,
      latencyP95Ms: null,
      latencyP99Ms: null,
      latencyMaxMs: null,
      minTimerMarginSec: null,
    });
    expect(latencyFields([10, 20, 30, 40], 12)).toMatchObject({
      decisions: 4,
      latencyP50Ms: 20,
      latencyP95Ms: 40,
      latencyP99Ms: 40,
      latencyMaxMs: 40,
      minTimerMarginSec: 12,
    });
  });

  it('keeps a missing rating and GXE null in the ops mapping', () => {
    expect(gxeOf(undefined)).toBeNull();
    expect(gxeOf({ gxe: 62.4 })).toBe(62.4);
    const record = buildLadderGameRecord(input({ eloAfter: null, gxe: null, opponentRating: null }));
    expect(record.schema).toBe('jev.ladder-game.v1');
    expect(record.durationMs).toBe(21_000);
    expect(record.endReason).toBe('ko');
    expect(record.latencyP50Ms).toBe(20);
    expect(record.latencyP99Ms).toBe(40);
    expect(record.latencyMaxMs).toBe(40);
    expect(record.minTimerMarginSec).toBe(12);
    expect(record).not.toHaveProperty('decisionLatencyMs');
    expect(record.replayStatus).toBe('unconfirmed');
    const ops = toOpsLiveGame(record);
    expect(ops.rating).toBeNull();
    expect(ops.gxe).toBeNull();
    expect(ops.kind).toBe('live-game');
    expect(ops.invalid).toBe(0);
    expect(JSON.stringify(ops)).not.toMatch(/"rating":1000|"gxe":50/);
  });

  it('hashes config independently of key order and reads the git sha from the environment', () => {
    expect(configHash({ b: 1, a: { d: 2, c: 3 } })).toBe(configHash({ a: { c: 3, d: 2 }, b: 1 }));
    const previous = process.env.JEV_GIT_SHA;
    process.env.JEV_GIT_SHA = 'abc123';
    expect(currentGitSha()).toBe('abc123');
    if (previous === undefined) delete process.env.JEV_GIT_SHA;
    else process.env.JEV_GIT_SHA = previous;
  });

  it('reads opponent, timer, and rating from a transcript without inventing defaults', () => {
    const facts = factsFromTranscript([
      '|player|p1|BotAlpha|1|1073',
      '|player|p2|Rival|2|1400',
      '|inactive|BotAlpha has 9 seconds left.',
      '|inactive|Rival has 2 seconds left.',
      '|-message|Rival forfeited.',
      '|win|BotAlpha',
    ], 'BotAlpha');
    expect(facts).toMatchObject({
      opponent: 'Rival',
      opponentRating: 1400,
      eloBefore: 1073,
      eloAfter: null,
      gxe: null,
      minTimerMarginSec: 9,
      winner: 'BotAlpha',
    });
    const rated = factsFromTranscript(['|rating|1100|62.4|1', '|win|Rival'], 'BotAlpha');
    expect(rated.eloAfter).toBe(1100);
    expect(rated.gxe).toBe(62.4);
    expect(rated.eloBefore).toBeNull();
  });

  it('records the battle replay id and a URL only when the server confirms it', () => {
    expect(replayIdFromBattle('battle-gen9randombattle-42')).toBe('gen9randombattle-42');
    const pending = buildLadderGameRecord(input());
    expect(pending.replayId).toBe('gen9randombattle-1');
    expect(pending.replayUrl).toBeNull();
    expect(pending.replayUploaded).toBe(false);
    expect(pending.replayStatus).toBe('unconfirmed');

    const confirmed = buildLadderGameRecord(input({
      replayId: 'gen9randombattle-1',
      replayUrl: 'https://replay.pokemonshowdown.com/gen9randombattle-1',
    }));
    expect(confirmed.replayUploaded).toBe(true);
    expect(confirmed.replayStatus).toBe('confirmed');

    const local = buildLadderGameRecord(input({ localServer: true }));
    expect(local.replayStatus).toBe('local-only');
    expect(local.replayUrl).toBeNull();
  });

  it('appends one JSON object per game', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-games-'));
    appendGameRecord(dir, buildLadderGameRecord(input()));
    appendGameRecord(dir, buildLadderGameRecord(input({ battleId: 'battle-gen9randombattle-2', winner: 'Rival', lines: ['|win|Rival'] })));
    const lines = fs.readFileSync(path.join(dir, 'games.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).battleId).toBe('battle-gen9randombattle-1');
    expect(JSON.parse(lines[1]).endReason).toBe('ko');
    expect(JSON.parse(lines[1]).outcome).toBe('loss');
  });
});

describe('BattleDriver game record', () => {
  beforeAll(() => {
    const loader = dataLoader as unknown as { loaded: boolean; stats: Record<string, unknown> };
    loader.loaded = true;
    loader.stats = {};
  });

  afterAll(() => {
    (dataLoader as unknown as { loaded: boolean }).loaded = false;
  });

  it('writes a forfeit, the opponent rating, and the version onto games.jsonl', async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-driver-games-'));
    const socket = new EventEmitter();
    const client = Object.assign(socket, {
      choose: () => true,
      saveReplay: () => true,
      enableBattleTimer: () => true,
      trackRoom: () => undefined,
      untrackRoom: () => undefined,
      isReady: () => true,
    }) as unknown as ShowdownClient;
    const driver = new BattleDriver({
      client,
      username: 'BotAlpha',
      format: gen9RandomBattle,
      engineName: 'max-damage',
      decisions: {
        openBattle() { /* unused */ },
        closeBattle() { /* unused */ },
        async stop() { /* unused */ },
      } as unknown as DecisionClient,
      logDir,
      decisionTimeoutMs: 1000,
      settleMs: 0,
      configId: 'champion',
      configHash: 'deadbeef',
      gitSha: '87b268f',
      concurrency: 3,
      localServer: false,
    });
    const ended = new Promise<import('./game-record.js').LadderGameRecord>(resolve => driver.on('gameEnd', resolve));
    const room = 'battle-gen9randombattle-9';
    socket.emit('line', room, '|player|p1|BotAlpha|1|1073');
    socket.emit('line', room, '|player|p2|Rival|2|1400');
    socket.emit('line', room, '|-message|Rival forfeited.');
    socket.emit('line', room, '|win|BotAlpha');
    const summary = await ended;
    expect(summary).toMatchObject({
      schema: 'jev.ladder-game.v1',
      kind: 'ladder-game',
      opponent: 'Rival',
      opponentRating: 1400,
      eloBefore: 1073,
      eloAfter: null,
      gxe: null,
      outcome: 'win',
      endReason: 'opponent-forfeit',
      engine: 'max-damage',
      configId: 'champion',
      configHash: 'deadbeef',
      gitSha: '87b268f',
      concurrency: 3,
      invalidChoices: 0,
      crashes: 0,
      fallbacks: 0,
      replayStatus: 'unconfirmed',
    });
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    const stored = JSON.parse(fs.readFileSync(path.join(logDir, 'games.jsonl'), 'utf8'));
    expect(stored.battleId).toBe(room);
    expect(stored.endReason).toBe('opponent-forfeit');
    expect(stored.replayId).toBe('gen9randombattle-9');
    await driver.stop();
  });

  it('writes the replay URL as soon as the server confirms it', async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-replay-'));
    const socket = new EventEmitter();
    const client = Object.assign(socket, {
      choose: () => true,
      saveReplay: () => true,
      enableBattleTimer: () => true,
      trackRoom: () => undefined,
      untrackRoom: () => undefined,
      isReady: () => true,
    }) as unknown as ShowdownClient;
    const driver = new BattleDriver({
      client,
      username: 'BotAlpha',
      format: gen9RandomBattle,
      engineName: 'max-damage',
      decisions: {
        openBattle() { /* unused */ },
        closeBattle() { /* unused */ },
        async stop() { /* unused */ },
      } as unknown as DecisionClient,
      logDir,
      decisionTimeoutMs: 1000,
      settleMs: 8000,
      localServer: false,
    });
    const ended = new Promise<import('./game-record.js').LadderGameRecord>(resolve => driver.on('gameEnd', resolve));
    const room = 'battle-gen9randombattle-9';
    const started = Date.now();
    socket.emit('line', room, '|player|p1|BotAlpha|1|');
    socket.emit('line', room, '|player|p2|Rival|2|');
    socket.emit('line', room, '|win|BotAlpha');
    socket.emit('replay', {
      id: 'gen9randombattle-9',
      url: 'https://replay.pokemonshowdown.com/gen9randombattle-9',
    });
    const summary = await ended;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(summary.replayUrl).toBe('https://replay.pokemonshowdown.com/gen9randombattle-9');
    expect(summary.replayId).toBe('gen9randombattle-9');
    expect(summary.replayStatus).toBe('confirmed');
    expect(summary.replayUploaded).toBe(true);
    expect(summary.localReplayPath).toEqual(expect.stringMatching(/\.log$/));
    expect(fs.existsSync(summary.localReplayPath as string)).toBe(true);
    await driver.stop();
  });
});
