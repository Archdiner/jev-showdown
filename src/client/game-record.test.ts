import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import {
  appendGameRecord,
  assertNewGameRow,
  buildLadderGameRecord,
  classifyEnd,
  groupByRunId,
  configHash,
  currentGitSha,
  eloDeltaConsistent,
  eloForGame,
  factsFromTranscript,
  gxeOf,
  isPhantomRecord,
  latencyFields,
  percentile,
  replayIdFromBattle,
  toOpsLiveGame,
  LADDER_ELO_FLOOR,
  LADDER_TIMER_START_SEC,
  TIMER_REASON_UNOBSERVED,
  claimBattle,
  publicReplayUrl,
  LadderGameInput,
} from './game-record.js';
import { replayMatchesRoom } from './showdown-client.js';
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
    expect(record.eloAfter).toBeNull();
    expect(record.eloAfterReason).toBe('unreported');
    expect(record.opponentRating).toBeNull();
    expect(record.opponentRatingReason).toBe('unreported');
    expect(JSON.stringify(record)).not.toMatch(/"opponentRating":-1|"eloAfter":-1/);
    expect(record).not.toHaveProperty('decisionLatencyMs');
    expect(record.replayStatus).toBe('unconfirmed');
    expect(record.beliefErrors).toBe(0);
    expect(buildLadderGameRecord(input({ beliefErrors: 3 })).beliefErrors).toBe(3);
    const ops = toOpsLiveGame(record);
    expect(ops.rating).toBeNull();
    expect(ops.opponentRating).toBeNull();
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

  it('reads the private turn clock into the game timer margin', () => {
    const lines = [
      '|player|p1|BotAlpha|1|1073',
      '|player|p2|Rival|2|1400',
      '|inactive|Time left: 150 sec this turn | 150 sec total | 60 sec grace',
      '|inactive|Time left: 37 sec this turn | 90 sec total',
      '|inactive|Rival has 4 seconds left.',
      '|inactive|BotAlpha has 20 seconds left.',
      '|win|BotAlpha',
    ];
    expect(factsFromTranscript(lines, 'BotAlpha').minTimerMarginSec).toBe(20);
    expect(buildLadderGameRecord(input({
      minTimerMarginSec: null,
      lines,
      latencies: [10],
    })).minTimerMarginSec).toBe(20);
    expect(buildLadderGameRecord(input({
      minTimerMarginSec: 12,
      lines,
    })).minTimerMarginSec).toBe(12);
  });

  it('flags a 0-turn disconnect with no winner as a phantom', () => {
    const ghost = buildLadderGameRecord(input({
      turns: 0,
      winner: null,
      lines: ['|init|battle'],
      disconnected: true,
      latencies: [],
    }));
    expect(ghost.phantom).toBe(true);
    expect(ghost.outcome).toBe('tie');
    expect(ghost.endReason).toBe('disconnect');
    expect(isPhantomRecord(ghost)).toBe(true);
    expect(isPhantomRecord({
      turns: 0,
      outcome: 'tie',
      endReason: 'disconnect',
      winner: null,
    })).toBe(true);
    const played = buildLadderGameRecord(input());
    expect(played.phantom).toBeUndefined();
    expect(isPhantomRecord(played)).toBe(false);
    expect(isPhantomRecord({ turns: 0, outcome: 'win', endReason: 'opponent-forfeit', winner: 'BotAlpha' })).toBe(false);
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
      ourSide: 'p1',
      opponent: 'Rival',
      opponentRating: 1400,
      eloBefore: null,
      preRating: 1073,
      eloAfter: null,
      gxe: null,
      minTimerMarginSec: 9,
      winner: 'BotAlpha',
    });
    const kept = buildLadderGameRecord(input({
      eloBefore: facts.eloBefore,
      eloAfter: facts.eloAfter,
      preRating: facts.preRating,
      lines: [
        '|player|p1|BotAlpha|1|1073',
        '|win|BotAlpha',
      ],
    }));
    expect(kept.eloBefore).toBe(1073);
    expect(kept.eloAfter).toBeNull();
    const rated = factsFromTranscript(['|rating|1100|62.4|1', '|win|Rival'], 'BotAlpha');
    expect(rated.eloAfter).toBe(1100);
    expect(rated.gxe).toBe(62.4);
    expect(rated.eloBefore).toBeNull();
  });

  it('drops an eloAfter that does not move with the result', () => {
    expect(eloDeltaConsistent('win', 1148, 1124)).toBe(false);
    expect(eloDeltaConsistent('win', 1072, 1088)).toBe(true);
    expect(eloDeltaConsistent('loss', 1185, 1169)).toBe(true);
    expect(eloDeltaConsistent('loss', 1185, 1200)).toBe(false);
    expect(eloDeltaConsistent('win', null, 1101)).toBe(true);
    expect(eloDeltaConsistent('win', 1072, null)).toBe(true);
    expect(eloDeltaConsistent('loss', LADDER_ELO_FLOOR, LADDER_ELO_FLOOR)).toBe(true);
    expect(eloDeltaConsistent('loss', 1100, 1100)).toBe(false);
    expect(eloDeltaConsistent('win', LADDER_ELO_FLOOR, LADDER_ELO_FLOOR)).toBe(false);
    const down = eloForGame({ outcome: 'win', ratingBefore: 1148, ratingAfter: 1124, preRating: 1072 });
    expect(down).toEqual({ eloBefore: 1072, eloAfter: null });
    const up = eloForGame({ outcome: 'win', ratingBefore: 1072, ratingAfter: 1088, preRating: 1072 });
    expect(up).toEqual({ eloBefore: 1072, eloAfter: 1088 });
    const bare = eloForGame({ outcome: 'win', ratingBefore: null, ratingAfter: 1101, preRating: 1072 });
    expect(bare).toEqual({ eloBefore: 1072, eloAfter: null });
    const floor = eloForGame({
      outcome: 'loss',
      ratingBefore: LADDER_ELO_FLOOR,
      ratingAfter: LADDER_ELO_FLOOR,
      preRating: LADDER_ELO_FLOOR,
    });
    expect(floor).toEqual({ eloBefore: LADDER_ELO_FLOOR, eloAfter: LADDER_ELO_FLOOR });
    const stuck = eloForGame({ outcome: 'loss', ratingBefore: 1100, ratingAfter: 1100, preRating: 1100 });
    expect(stuck).toEqual({ eloBefore: 1100, eloAfter: null });
    const loss = buildLadderGameRecord(input({
      winner: 'Rival',
      lines: ['|win|Rival'],
      eloBefore: 1185,
      eloAfter: 1200,
      preRating: 1185,
      gxe: 51,
    }));
    expect(loss.outcome).toBe('loss');
    expect(loss.eloBefore).toBe(1185);
    expect(loss.eloAfter).toBeNull();
    expect(loss.eloAfterReason).toBe('unreported');
    expect(loss.gxe).toBeNull();
  });

  it('stores one invalid-choice reason per error line and caps the list', () => {
    const lines = [
      '|error|[Invalid choice] Can\'t undo: A trapping/disabling effect would cause undo to leak information',
      '|c|BotAlpha|invalid choice echo',
      '|error|[Invalid choice] Sorry, too late to make a different move; the next turn has already started',
    ];
    for (let i = 0; i < 10; i++) lines.push(`|bigerror|[Invalid choice] reason ${i}`);
    const facts = factsFromTranscript(lines, 'BotAlpha');
    expect(facts.invalidChoices).toBe(12);
    expect(facts.invalidChoiceReasons).toHaveLength(8);
    expect(facts.invalidChoiceReasons[0]).toContain("Can't undo");
    expect(facts.invalidChoiceReasons[1]).toContain('too late');
    const record = buildLadderGameRecord(input({ lines, invalidChoices: facts.invalidChoices }));
    expect(record.invalidChoices).toBe(12);
    expect(record.invalidChoiceReasons).toEqual(facts.invalidChoiceReasons);
  });

  it('records a replay link even before the server confirms the upload', () => {
    expect(replayIdFromBattle('battle-gen9randombattle-42')).toBe('gen9randombattle-42');
    const pending = buildLadderGameRecord(input());
    expect(pending.replayId).toBe('gen9randombattle-1');
    expect(pending.replayUrl).toBe('https://replay.pokemonshowdown.com/gen9randombattle-1');
    expect(pending.replayUnavailableReason).toBeNull();
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
    expect(local.replayUrl).toBe('/tmp/replay.log');
    expect(local.replayUnavailableReason).toBe('local-server');
  });

  it('keeps the hidden-room suffix on the replay link', () => {
    const battleId = 'battle-gen9randombattle-2692991009-9o3axjtwpdkaa41h7pskjmbgwkgko89pw';
    expect(replayMatchesRoom(battleId, 'gen9randombattle-2692991009')).toBe(true);
    expect(replayMatchesRoom('battle-gen9randombattle-10', 'gen9randombattle-1')).toBe(false);
    expect(publicReplayUrl(battleId)).toBe(
      'https://replay.pokemonshowdown.com/gen9randombattle-2692991009-9o3axjtwpdkaa41h7pskjmbgwkgko89pw',
    );
    const hidden = buildLadderGameRecord(input({ battleId, replayUrl: null, replayId: null }));
    expect(hidden.replayUrl).toBe(
      'https://replay.pokemonshowdown.com/gen9randombattle-2692991009-9o3axjtwpdkaa41h7pskjmbgwkgko89pw',
    );
    expect(hidden.replayId).toBe('gen9randombattle-2692991009-9o3axjtwpdkaa41h7pskjmbgwkgko89pw');
  });

  it('records the opening clock when the game ends before any timer line', () => {
    const forfeited = buildLadderGameRecord(input({
      battleId: 'battle-gen9randombattle-2692991018',
      turns: 3,
      minTimerMarginSec: null,
      lines: ['|turn|3', '|-message|Rival forfeited.', '|win|BotAlpha'],
      winner: 'BotAlpha',
      latencies: [],
    }));
    expect(forfeited.endReason).toBe('opponent-forfeit');
    expect(forfeited.turns).toBe(3);
    expect(forfeited.minTimerMarginSec).toBe(LADDER_TIMER_START_SEC);
    expect(forfeited.minTimerMarginReason).toBe(TIMER_REASON_UNOBSERVED);
    expect(forfeited.replayUrl).not.toBeNull();
    expect(forfeited.durationMs).toBe(21_000);
    expect(forfeited.configId).toBe('unconfigured');
    expect(forfeited.gitSha).toBe('87b268f');
  });

  it('requires runId on new game rows', () => {
    const stamped = buildLadderGameRecord(input({
      runId: '1710000000000',
      batchLabel: 'batch-9',
      hostname: 'live-mac',
    }));
    expect(stamped.runId).toBe('1710000000000');
    expect(stamped.batchLabel).toBe('batch-9');
    expect(stamped.hostname).toBe('live-mac');
    expect(() => assertNewGameRow(stamped)).not.toThrow();
    expect(buildLadderGameRecord(input()).runId).toEqual(expect.any(String));
    expect(buildLadderGameRecord(input()).runId.length).toBeGreaterThan(0);
    expect(() => assertNewGameRow({ schema: 'jev.ladder-game.v1' })).toThrow(/runId/);
    expect(() => assertNewGameRow({ schema: 'jev.ladder-game.v1', runId: '   ' })).toThrow(/runId/);
    expect(() => assertNewGameRow({ turns: 0, outcome: 'tie', endReason: 'disconnect' })).not.toThrow();
    const previousLabel = process.env.LIVE_BATCH_LABEL;
    process.env.LIVE_BATCH_LABEL = 'from-env';
    try {
      expect(buildLadderGameRecord(input()).batchLabel).toBe('from-env');
    } finally {
      if (previousLabel === undefined) delete process.env.LIVE_BATCH_LABEL;
      else process.env.LIVE_BATCH_LABEL = previousLabel;
    }
    expect(groupByRunId([
      { runId: 'a', batchLabel: 'batch-9', hostname: 'live-mac', outcome: 'win' },
      { runId: 'a', outcome: 'loss' },
      { runId: 'b', hostname: 'other', outcome: 'win' },
      { outcome: 'tie' },
    ])).toEqual([
      { runId: 'a', batchLabel: 'batch-9', hostname: 'live-mac', wins: 1, losses: 1, ties: 0, games: 2 },
      { runId: 'b', batchLabel: null, hostname: 'other', wins: 1, losses: 0, ties: 0, games: 1 },
      { runId: 'unknown', batchLabel: null, hostname: null, wins: 0, losses: 0, ties: 1, games: 1 },
    ]);
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

  it('writes one row when the same process finalizes a battle twice', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-idempotent-'));
    const record = buildLadderGameRecord(input());
    expect(appendGameRecord(dir, record).reason).toBe('appended');
    expect(appendGameRecord(dir, record).reason).toBe('duplicate');
    const lines = fs.readFileSync(path.join(dir, 'games.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('does not let a second process append another row for the same battle', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-owner-'));
    const battleId = 'battle-gen9randombattle-2692985848';
    expect(claimBattle(dir, battleId, 100).owned).toBe(true);
    const intruder = buildLadderGameRecord(input({
      battleId,
      pid: 53856,
      turns: 4,
      winner: null,
      lines: ['|turn|4'],
      disconnected: true,
      opponent: 'Jxjdndnd',
    }));
    expect(intruder.outcome).toBe('tie');
    expect(intruder.endReason).toBe('disconnect');
    expect(appendGameRecord(dir, intruder)).toMatchObject({ written: false, reason: 'non-owning-process' });
    const owner = buildLadderGameRecord(input({
      battleId,
      pid: 100,
      winner: 'Jxjdndnd',
      lines: ['|win|Jxjdndnd'],
      opponent: 'Jxjdndnd',
    }));
    expect(appendGameRecord(dir, owner).reason).toBe('appended');
    const lines = fs.readFileSync(path.join(dir, 'games.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).outcome).toBe('loss');
    expect(JSON.parse(lines[0]).pid).toBe(100);
    const flags = fs.readFileSync(path.join(dir, 'games.contamination.jsonl'), 'utf8');
    expect(flags).toContain('non-owning-process');
    expect(flags).toContain('53856');
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
      eloAfterReason: 'unreported',
      gxe: null,
      outcome: 'win',
      endReason: 'opponent-forfeit',
      engine: 'max-damage',
      ourSide: 'p1',
      configId: 'champion',
      configHash: 'deadbeef',
      gitSha: '87b268f',
      concurrency: 3,
      invalidChoices: 0,
      crashes: 0,
      fallbacks: 0,
      beliefErrors: 0,
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

  it('stores a passworded replay popup on the game record', async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-replay-pw-'));
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
      engineName: 'search',
      decisions: {
        openBattle() { /* unused */ },
        closeBattle() { /* unused */ },
        async stop() { /* unused */ },
        async decide() {
          return { action: { type: 'move' as const, moveIndex: 1 }, score: 1, timeMs: 1, fallback: true, reason: 'engine timeout' };
        },
      } as unknown as DecisionClient,
      logDir,
      decisionTimeoutMs: 1000,
      settleMs: 0,
    });
    const ended = new Promise<import('./game-record.js').LadderGameRecord>(resolve => driver.on('gameEnd', resolve));
    const room = 'battle-gen9randombattle-9';
    socket.emit('line', room, '|player|p1|BotAlpha|1|1185');
    socket.emit('line', room, '|player|p2|Rival|2|1400');
    socket.emit('line', room, '|turn|4');
    socket.emit('popup', 'uploaded https://replay.pokemonshowdown.com/gen9randombattle-9-vf14y87snr046p0x7g86l2ffrf1912epw');
    socket.emit('line', room, `|request|${JSON.stringify({
      rqid: 2,
      side: { id: 'p1', pokemon: [{ ident: 'p1: A', details: 'A', condition: '100/100', active: true }] },
      active: [{ moves: [{ move: 'Tackle', id: 'tackle', pp: 35, maxpp: 35, target: 'normal', disabled: false }] }],
    })}`);
    await new Promise(resolve => setTimeout(resolve, 40));
    socket.emit('line', room, '|win|BotAlpha');
    const summary = await ended;
    expect(summary.replayUrl).toBe('https://replay.pokemonshowdown.com/gen9randombattle-9-vf14y87snr046p0x7g86l2ffrf1912epw');
    expect(summary.replayId).toBe('gen9randombattle-9');
    expect(summary.replayStatus).toBe('confirmed');
    expect(summary.fallbacks).toBe(1);
    expect(summary.phantom).toBeUndefined();
    await driver.stop();
  });

  it('does not count a ghost room that disconnects before any turn', async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-phantom-'));
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
      engineName: 'search',
      decisions: {
        openBattle() { /* unused */ },
        closeBattle() { /* unused */ },
        async stop() { /* unused */ },
      } as unknown as DecisionClient,
      logDir,
      decisionTimeoutMs: 1000,
      settleMs: 0,
    });
    const ended = new Promise<import('./game-record.js').LadderGameRecord>(resolve => driver.on('gameEnd', resolve));
    socket.emit('line', 'battle-gen9randombattle-ghost', '|init|battle');
    const summary = await driver.stop().then(() => ended);
    expect(summary.phantom).toBe(true);
    expect(summary.turns).toBe(0);
    expect(summary.endReason).toBe('disconnect');
    const stored = JSON.parse(fs.readFileSync(path.join(logDir, 'games.jsonl'), 'utf8')) as { phantom?: boolean };
    expect(stored.phantom).toBe(true);
  });

  it('keeps one games.jsonl row when a second pid writes the same battle', async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-dup-proc-'));
    const socket = new EventEmitter();
    const driver = new BattleDriver({
      client: Object.assign(socket, {
        choose: () => true,
        saveReplay: () => true,
        enableBattleTimer: () => true,
        trackRoom: () => undefined,
        untrackRoom: () => undefined,
        isReady: () => true,
      }) as unknown as ShowdownClient,
      username: 'BotAlpha',
      format: gen9RandomBattle,
      engineName: 'search',
      decisions: {
        openBattle() { /* unused */ },
        closeBattle() { /* unused */ },
        async stop() { /* unused */ },
      } as unknown as DecisionClient,
      logDir,
      decisionTimeoutMs: 1000,
      settleMs: 0,
    });
    const ended = new Promise<import('./game-record.js').LadderGameRecord>(resolve => driver.on('gameEnd', resolve));
    const room = 'battle-gen9randombattle-2692985848';
    socket.emit('line', room, '|player|p1|BotAlpha|1|1100');
    socket.emit('line', room, '|player|p2|Jxjdndnd|2|1400');
    socket.emit('line', room, '|turn|4');
    const intruder = buildLadderGameRecord(input({
      battleId: room,
      pid: 53856,
      turns: 4,
      winner: null,
      lines: ['|turn|4'],
      disconnected: true,
      opponent: 'Jxjdndnd',
      opponentRating: 1400,
    }));
    expect(appendGameRecord(logDir, intruder).reason).toBe('non-owning-process');
    socket.emit('line', room, '|win|Jxjdndnd');
    const summary = await ended;
    expect(summary.contaminated).toBeUndefined();
    expect(summary.outcome).toBe('loss');
    const lines = fs.readFileSync(path.join(logDir, 'games.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).pid).toBe(process.pid);
    await driver.stop();
  });

  it('writes a suffixed replay url and the opening timer when the clock never arrives', async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-suffix-timer-'));
    const socket = new EventEmitter();
    const driver = new BattleDriver({
      client: Object.assign(socket, {
        choose: () => true,
        saveReplay: () => true,
        enableBattleTimer: () => true,
        trackRoom: () => undefined,
        untrackRoom: () => undefined,
        isReady: () => true,
      }) as unknown as ShowdownClient,
      username: 'BotAlpha',
      format: gen9RandomBattle,
      engineName: 'search',
      decisions: {
        openBattle() { /* unused */ },
        closeBattle() { /* unused */ },
        async stop() { /* unused */ },
      } as unknown as DecisionClient,
      logDir,
      decisionTimeoutMs: 1000,
      settleMs: 0,
    });
    const ended = new Promise<import('./game-record.js').LadderGameRecord>(resolve => driver.on('gameEnd', resolve));
    const room = 'battle-gen9randombattle-2692991009-9o3axjtwpdkaa41h7pskjmbgwkgko89pw';
    socket.emit('line', room, '|player|p1|BotAlpha|1|1100');
    socket.emit('line', room, '|player|p2|Rival|2|1400');
    socket.emit('line', room, '|turn|3');
    socket.emit('line', room, '|-message|Rival forfeited.');
    socket.emit('line', room, '|win|BotAlpha');
    const summary = await ended;
    expect(summary.replayUrl).toBe(
      'https://replay.pokemonshowdown.com/gen9randombattle-2692991009-9o3axjtwpdkaa41h7pskjmbgwkgko89pw',
    );
    expect(summary.minTimerMarginSec).toBe(LADDER_TIMER_START_SEC);
    expect(summary.minTimerMarginReason).toBe(TIMER_REASON_UNOBSERVED);
    expect(summary.endReason).toBe('opponent-forfeit');
    expect(summary.turns).toBe(3);
    const stored = JSON.parse(fs.readFileSync(path.join(logDir, 'games.jsonl'), 'utf8')) as {
      replayUrl: string;
      minTimerMarginSec: number;
    };
    expect(stored.replayUrl).toBe(summary.replayUrl);
    expect(stored.minTimerMarginSec).toBe(150);
    await driver.stop();
  });
});
