import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BattleDriver } from './battle-driver.js';
import { DecisionClient } from './decision-client.js';
import { ShowdownClient } from './showdown-client.js';
import { dataLoader } from '../data/data-loader.js';
import { gen9RandomBattle } from '../formats/gen9-randombattle.js';

beforeAll(() => {
  const loader = dataLoader as unknown as { loaded: boolean; stats: Record<string, unknown> };
  loader.loaded = true;
  loader.stats = {};
});

afterAll(() => {
  (dataLoader as unknown as { loaded: boolean }).loaded = false;
});

function client(): ShowdownClient {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    choose: () => true,
    saveReplay: () => true,
    trackRoom: () => undefined,
    untrackRoom: () => undefined,
    isReady: () => true,
  }) as unknown as ShowdownClient;
}

function decisions(): DecisionClient {
  return {
    openBattle() { /* unused */ },
    closeBattle() { /* unused */ },
    async stop() { /* unused */ },
  } as unknown as DecisionClient;
}

async function finish(lines: string[]): Promise<{ summaryGxe: number | null; summaryElo: number | null; events: Array<Record<string, unknown>> }> {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-rating-'));
  const driver = new BattleDriver({
    client: client(),
    username: 'BotAlpha',
    format: gen9RandomBattle,
    engineName: 'max-damage',
    decisions: decisions(),
    logDir,
    decisionTimeoutMs: 1000,
    settleMs: 0,
  });
  const ended = new Promise<import('./battle-driver.js').GameSummary>(resolve => {
    driver.on('gameEnd', resolve);
  });
  const room = 'battle-gen9randombattle-1';
  const socket = (driver as unknown as { options: { client: EventEmitter } }).options.client;
  for (const line of lines) socket.emit('line', room, line);
  const summary = await ended;
  await driver.stop();
  const logPath = path.join(logDir, 'botalpha-battle-gen9randombattle-1.jsonl');
  const events = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  return { summaryGxe: summary.gxe, summaryElo: summary.eloAfter, events };
}

describe('ladder rating records', () => {
  it('stores a parsed GXE and does not invent one when the popup omits it', async () => {
    const withGxe = await finish([
      '|player|p1|BotAlpha|1|1073',
      '|player|p2|Rival|2|1400',
      `|raw|BotAlpha's rating: 1073 &rarr; <strong>1089</strong><br />(+16 for winning)<br />(GXE: 62.4)`,
      '|win|BotAlpha',
    ]);
    expect(withGxe.summaryGxe).toBe(62.4);
    expect(withGxe.summaryElo).toBe(1089);
    const rating = withGxe.events.find(event => event.type === 'rating');
    expect(rating).toMatchObject({
      kind: 'rating',
      before: 1073,
      after: 1089,
      gxe: 62.4,
      gxeSource: 'html',
      opponent: 'Rival',
      opponentRating: 1400,
      fabricated: false,
    });
    const result = withGxe.events.find(event => event.type === 'result');
    expect(result).toMatchObject({ gxe: 62.4, eloBefore: 1073, eloAfter: 1089, gxeSource: 'html' });

    const missing = await finish([
      '|player|p1|BotAlpha|1|',
      '|player|p2|Rival|2|',
      '|win|Rival',
    ]);
    expect(missing.summaryGxe).toBeNull();
    expect(missing.summaryElo).toBeNull();
    expect(missing.events.some(event => event.gxe === 50 || event.eloAfter === 1000 || event.after === 1000)).toBe(false);
    const missingResult = missing.events.find(event => event.type === 'result');
    expect(missingResult).toMatchObject({ gxe: null, eloBefore: null, eloAfter: null, gxeSource: 'missing' });
  });

  it('reads a forfeit rating popup that arrives after the result', async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-rating-popup-'));
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
      engineName: 'max-damage',
      decisions: decisions(),
      logDir,
      decisionTimeoutMs: 1000,
      settleMs: 30,
    });
    const ended = new Promise<import('./battle-driver.js').GameSummary>(resolve => driver.on('gameEnd', resolve));
    const room = 'battle-gen9randombattle-1';
    socket.emit('line', room, '|player|p1|BotAlpha|1|1185');
    socket.emit('line', room, '|player|p2|Rival|2|1400');
    socket.emit('line', room, '|-message|BotAlpha forfeited.');
    socket.emit('line', room, '|win|Rival');
    socket.emit('popup', `BotAlpha's rating: 1185 &rarr; <strong>1169</strong><br />(GXE: 51.2%)`);
    const summary = await ended;
    expect(summary.eloBefore).toBe(1185);
    expect(summary.eloAfter).toBe(1169);
    expect(summary.gxe).toBe(51.2);
    expect(summary.endReason).toBe('our-forfeit');
    await driver.stop();
  });

  it('fetches /rank when a disconnect never sent a rating line', async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-rating-rank-'));
    const socket = new EventEmitter();
    const table = '|raw|<div class="ladder"><table><tr><td>gen9randombattle</td><td><strong>1185</strong></td></tr></table></div>';
    const driver = new BattleDriver({
      client: Object.assign(socket, {
        choose: () => true,
        saveReplay: () => true,
        enableBattleTimer: () => true,
        trackRoom: () => undefined,
        untrackRoom: () => undefined,
        isReady: () => true,
        queryRank: () => {
          setTimeout(() => socket.emit('line', '', table), 5);
          return true;
        },
      }) as unknown as ShowdownClient,
      username: 'BotAlpha',
      format: gen9RandomBattle,
      engineName: 'max-damage',
      decisions: decisions(),
      logDir,
      decisionTimeoutMs: 1000,
      settleMs: 0,
    });
    const ended = new Promise<import('./battle-driver.js').GameSummary>(resolve => driver.on('gameEnd', resolve));
    const room = 'battle-gen9randombattle-1';
    socket.emit('line', room, '|player|p1|BotAlpha|1|1200');
    socket.emit('line', room, '|player|p2|Rival|2|1400');
    socket.emit('line', room, '|turn|6');
    const summary = await driver.stop().then(() => ended);
    expect(summary.endReason).toBe('disconnect');
    expect(summary.turns).toBe(6);
    expect(summary.phantom).toBeUndefined();
    expect(summary.eloAfter).toBe(1185);
  });

  it('keeps a |rating| line that has elo and no GXE', async () => {
    const row = await finish([
      '|player|p1|BotAlpha|1|1100',
      '|player|p2|Rival|2|',
      '|rating|1100',
      '|win|BotAlpha',
    ]);
    expect(row.summaryElo).toBe(1100);
    expect(row.summaryGxe).toBeNull();
    expect(row.events.find(event => event.type === 'rating')).toMatchObject({
      after: 1100,
      before: null,
      gxe: null,
      gxeSource: 'missing',
      fabricated: false,
    });
  });
});
