import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { EXACT_1PLY, exactSearch, modalReply, reseed } from '../engine/exact/search.js';
import { cloneBattle, cloneFromSnapshot, legalChoices, playChoices, snapshot, startRandomBattle, teamsForSeed } from '../engine/exact/battle-utils.js';
import { buildCalibrationReport } from '../analysis/calibration.js';
import { BattleDriver } from './battle-driver.js';
import { DecisionClient } from './decision-client.js';
import { ShowdownClient } from './showdown-client.js';
import { dataLoader } from '../data/data-loader.js';
import { gen9RandomBattle } from '../formats/gen9-randombattle.js';
import {
  PredictionLog,
  formatCalibrationReport,
  observeResolution,
  scoreResolution,
  summarizeSamples,
  scoreToSample,
} from './prediction.js';
import { TURN_FORECAST_SCHEMA, forecastLine, hpFraction, type TurnForecast } from './turn-forecast.js';

function opened(seed = 7) {
  const teams = teamsForSeed(seed);
  const battle = startRandomBattle(teams.p1, teams.p2, seed);
  if (battle.requestState === 'teampreview') {
    battle.choose('p1', 'default');
    battle.choose('p2', 'default');
  }
  return battle;
}

function forecastOf(over: Partial<TurnForecast> = {}): TurnForecast {
  return {
    schema: TURN_FORECAST_SCHEMA,
    ourChoice: 'move 1',
    foeChoice: 'move 1',
    ourAction: 'tackle',
    foeAction: 'ember',
    foeModel: 'max-damage',
    ourSpecies: 'Pikachu',
    foeSpecies: 'Charmander',
    ourHpBefore: 1,
    foeHpBefore: 1,
    ourHpAfter: 0.8,
    foeHpAfter: 0.5,
    damageDealt: 0.5,
    damageTaken: 0.2,
    ourKo: false,
    foeKo: false,
    firstActor: 'us',
    stepped: true,
    samples: 1,
    ...over,
  };
}

describe('turn forecast', () => {
  it('matches one seeded rollout and leaves the live battle alone', () => {
    const battle = opened(11);
    const choice = legalChoices(battle, 'p1').find(item => item.startsWith('move ')) || legalChoices(battle, 'p1')[0];
    const beforeHp = battle.p1.active[0].hp;
    const beforeLog = battle.log.length;
    const config = { ...EXACT_1PLY, samples: 1 };
    const forecast = forecastLine(battle, 'p1', choice, config);
    expect(forecast).not.toBeNull();
    if (!forecast) return;
    expect(battle.p1.active[0].hp).toBe(beforeHp);
    expect(battle.log.length).toBe(beforeLog);
    expect(forecast.schema).toBe(TURN_FORECAST_SCHEMA);
    expect(forecast.stepped).toBe(true);
    expect(forecast.samples).toBe(1);
    expect(forecast.ourAction).toBeTruthy();

    const reply = modalReply(battle, 'p1', config);
    const next = cloneFromSnapshot(snapshot(battle));
    reseed(next, 0);
    const mark = next.log.length;
    expect(playChoices(next, 'p1', choice, reply || undefined)).toBe(true);
    const our = next.p1.pokemon[battle.p1.pokemon.indexOf(battle.p1.active[0])];
    const foe = next.p2.pokemon[battle.p2.pokemon.indexOf(battle.p2.active[0])];
    expect(forecast.ourHpAfter).toBeCloseTo(hpFraction(our.hp, our.maxhp, our.fainted) ?? -1, 3);
    expect(forecast.foeHpAfter).toBeCloseTo(hpFraction(foe.hp, foe.maxhp, foe.fainted) ?? -1, 3);
    expect(forecast.foeChoice).toBe(reply);
    const first = next.log.slice(mark).find(line => line.startsWith('|move|') || line.startsWith('|switch|'));
    if (first?.split('|')[2]?.startsWith('p1')) expect(forecast.firstActor).toBe('us');
    if (first?.split('|')[2]?.startsWith('p2')) expect(forecast.firstActor).toBe('foe');
  });

  it('does not change the search choice', () => {
    const battle = opened(11);
    const left = exactSearch(cloneBattle(battle), 'p1', EXACT_1PLY).choice;
    forecastLine(battle, 'p1', left, EXACT_1PLY);
    const right = exactSearch(cloneBattle(battle), 'p1', EXACT_1PLY).choice;
    expect(left).toBe(right);
  });

  it('stays a small fraction of a search', () => {
    const battle = opened(4);
    const choice = legalChoices(battle, 'p1')[0];
    const started = Date.now();
    const forecast = forecastLine(battle, 'p1', choice, EXACT_1PLY);
    expect(forecast?.samples).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(250);
  });
});

describe('prediction scores', () => {
  const lines = [
    '|move|p1a: Pikachu|Tackle|p2a: Charmander',
    '|-damage|p2a: Charmander|40/100',
    '|move|p2a: Charmander|Ember|p1a: Pikachu',
    '|-damage|p1a: Pikachu|70/100',
    '|turn|2',
  ];

  it('compares action, damage, KO, and speed against the protocol', () => {
    const score = scoreResolution({
      forecast: forecastOf(),
      baseline: { ourSide: 'p1', ourHpBefore: 1, foeHpBefore: 1 },
      lines,
      turn: 1,
      rqid: 2,
    });
    expect(score.comparable).toBe(true);
    expect(score.foeActionMatch).toBe(true);
    expect(score.ourActionMatch).toBe(true);
    expect(score.actual.damageDealt).toBeCloseTo(0.6, 4);
    expect(score.actual.damageTaken).toBeCloseTo(0.3, 4);
    expect(score.damageDealtAbs).toBeCloseTo(0.1, 4);
    expect(score.damageTakenAbs).toBeCloseTo(0.1, 4);
    expect(score.ourKoMismatch).toBe(false);
    expect(score.foeKoMismatch).toBe(false);
    expect(score.speedOrderMismatch).toBe(false);
    expect(score.actual.firstActor).toBe('us');
  });

  it('flags a wrong foe move, a missed KO, and a flipped speed order', () => {
    const missed = [
      '|move|p2a: Charmander|Flamethrower|p1a: Pikachu',
      '|-damage|p1a: Pikachu|0 fnt',
      '|faint|p1a: Pikachu',
      '|move|p1a: Pikachu|Tackle|p2a: Charmander',
    ];
    const actual = observeResolution(missed, forecastOf(), { ourSide: 'p1', ourHpBefore: 1, foeHpBefore: 1 });
    expect(actual.foeAction).toBe('flamethrower');
    expect(actual.ourKo).toBe(true);
    expect(actual.firstActor).toBe('foe');
    const score = scoreResolution({
      forecast: forecastOf({ foeKo: true, ourKo: false }),
      baseline: { ourSide: 'p1', ourHpBefore: 1, foeHpBefore: 1 },
      lines: missed,
      turn: 4,
      rqid: null,
    });
    expect(score.foeActionMatch).toBe(false);
    expect(score.ourKoMismatch).toBe(true);
    expect(score.foeKoMismatch).toBe(true);
    expect(score.speedOrderMismatch).toBe(true);
  });

  it('does not count a forfeit with no battle lines', () => {
    const score = scoreResolution({
      forecast: forecastOf(),
      baseline: { ourSide: 'p2', ourHpBefore: 1, foeHpBefore: 1 },
      lines: ['|-message|Rival forfeited.'],
      turn: 3,
      rqid: 1,
    });
    expect(score.comparable).toBe(false);
    const summary = summarizeSamples([scoreToSample(score)]);
    expect(summary?.turns).toBe(1);
    expect(summary?.compared).toBe(0);
    expect(summary?.foeActionAccuracy).toBeNull();
  });

  it('aggregates absolute damage and rates', () => {
    const log = new PredictionLog();
    log.start({
      forecast: forecastOf(),
      baseline: { ourSide: 'p1', ourHpBefore: 1, foeHpBefore: 1 },
      turn: 1,
      rqid: 1,
    });
    for (const line of lines) log.observe(line);
    const score = log.observe('|request|{"wait":true}');
    expect(score?.foeActionMatch).toBe(true);
    const summary = log.summary();
    expect(summary).toMatchObject({
      turns: 1,
      compared: 1,
      foeActionCorrect: 1,
      foeActionAccuracy: 1,
      damageDealtN: 1,
    });
    expect(formatCalibrationReport(summary)).toContain('foe action: 1/1 (100.0%)');
    expect(log.observe('not a line')).toBeNull();
    expect(log.close()).toBeNull();
  });
});

describe('calibration report', () => {
  it('rescores turn forecasts from the replay when the live row is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cal-'));
    const name = 'bot-battle-1';
    const forecast = forecastOf({ damageDealt: 0.5, damageTaken: 0.5, ourHpAfter: 0.5, foeHpAfter: 0.5 });
    const turn = {
      type: 'turn',
      battleId: 'battle-1',
      turn: 1,
      rqid: 1,
      engine: 'search',
      prediction: forecast,
      predictionBaseline: { ourSide: 'p1', ourHpBefore: 1, foeHpBefore: 1 },
    };
    fs.writeFileSync(path.join(dir, `${name}.jsonl`), `${JSON.stringify(turn)}\n`);
    fs.mkdirSync(path.join(dir, 'replays'));
    fs.writeFileSync(path.join(dir, 'replays', `${name}.log`), [
      '|request|{"active":[{}]}',
      '|move|p1a: Pikachu|Tackle|p2a: Charmander',
      '|-damage|p2a: Charmander|50/100',
      '|move|p2a: Charmander|Ember|p1a: Pikachu',
      '|-damage|p1a: Pikachu|50/100',
    ].join('\n'));
    const report = buildCalibrationReport(dir);
    expect(report.summary?.compared).toBe(1);
    expect(report.summary?.foeActionCorrect).toBe(1);
    expect(report.summary?.damageDealtMae).toBe(0);
    expect(report.summary?.damageTakenMae).toBe(0);
    expect(report.text).toContain('foe action: 1/1');
    expect(report.byEngine[0].engine).toBe('search');
  });
});

describe('BattleDriver prediction log', () => {
  beforeAll(() => {
    const loader = dataLoader as unknown as { loaded: boolean; stats: Record<string, unknown> };
    loader.loaded = true;
    loader.stats = {};
  });

  it('sends the choice before forecasting and records the error', async () => {
    const battle = opened(9);
    const our = battle.p1.active[0];
    const foe = battle.p2.active[0];
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-pred-'));
    const socket = new EventEmitter();
    let decidedAt = 0;
    let sentAt = 0;
    const sent = new Promise<void>(resolve => {
      Object.assign(socket, {
        choose: () => {
          sentAt = Date.now();
          resolve();
          return true;
        },
        saveReplay: () => true,
        trackRoom: () => undefined,
        untrackRoom: () => undefined,
        isReady: () => true,
      });
    });
    const driver = new BattleDriver({
      client: socket as unknown as ShowdownClient,
      username: 'BotAlpha',
      format: gen9RandomBattle,
      engineName: 'search',
      decisions: {
        openBattle() { /* unused */ },
        closeBattle() { /* unused */ },
        async stop() { /* unused */ },
        async decide() {
          decidedAt = Date.now();
          return { action: { type: 'move' as const, moveIndex: 1 }, score: 1, timeMs: 4, fallback: false };
        },
      } as unknown as DecisionClient,
      logDir,
      decisionTimeoutMs: 1000,
      settleMs: 0,
      configId: 'champion-exact-1ply',
      configHash: 'abc',
      gitSha: '67822d8',
      concurrency: 1,
    });
    const ended = new Promise<import('./game-record.js').LadderGameRecord>(resolve => driver.on('gameEnd', resolve));
    const room = 'battle-gen9randombattle-3';
    const request = JSON.parse(JSON.stringify(battle.p1.activeRequest));
    socket.emit('line', room, '|player|p1|BotAlpha|1|1100');
    socket.emit('line', room, '|player|p2|Rival|2|1400');
    socket.emit('line', room, `|switch|p1a: ${our.species.name}|${our.species.name}, L${our.level}|${our.hp}/${our.maxhp}`);
    socket.emit('line', room, `|switch|p2a: ${foe.species.name}|${foe.species.name}, L${foe.level}|${foe.hp}/${foe.maxhp}`);
    socket.emit('line', room, '|turn|1');
    socket.emit('line', room, `|request|${JSON.stringify(request)}`);
    await sent;
    expect(sentAt - decidedAt).toBeLessThan(20);
    const ourMove = our.moveSlots[0].move;
    socket.emit('line', room, `|move|p2a: ${foe.species.name}|Tackle|p1a: ${our.species.name}`);
    socket.emit('line', room, `|-damage|p1a: ${our.species.name}|${Math.max(1, our.hp - 10)}/${our.maxhp}`);
    socket.emit('line', room, `|move|p1a: ${our.species.name}|${ourMove}|p2a: ${foe.species.name}`);
    socket.emit('line', room, `|-damage|p2a: ${foe.species.name}|80/100`);
    socket.emit('line', room, '|win|Rival');
    const summary = await ended;
    expect(summary.calibration?.compared).toBe(1);
    expect(summary.calibration?.turns).toBe(1);
    expect(summary.calibration?.ourActions).toBe(1);
    const file = fs.readdirSync(logDir).find(name => name.endsWith('.jsonl') && name !== 'games.jsonl');
    const text = fs.readFileSync(path.join(logDir, file || ''), 'utf8');
    expect(text).toContain('"type":"prediction_error"');
    expect(text).toContain(TURN_FORECAST_SCHEMA);
    expect(text).toContain('"schema":"jev.prediction-error.v1"');
    const games = JSON.parse(fs.readFileSync(path.join(logDir, 'games.jsonl'), 'utf8'));
    expect(games.calibration.compared).toBe(1);
    await driver.stop();
  });
});
