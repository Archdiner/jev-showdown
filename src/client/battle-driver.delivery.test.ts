import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BattleDriver, GameSummary } from './battle-driver.js';
import { roomLines } from './protocol-frames.js';
import { DecisionClient } from './decision-client.js';
import { ShowdownClient } from './showdown-client.js';
import { dataLoader } from '../data/data-loader.js';
import { gen9RandomBattle } from '../formats/gen9-randombattle.js';
import { Action } from '../types/index.js';

beforeAll(() => {
  const loader = dataLoader as unknown as { loaded: boolean; stats: Record<string, unknown> };
  loader.loaded = true;
  loader.stats = {};
});

afterAll(() => {
  (dataLoader as unknown as { loaded: boolean }).loaded = false;
});

const MOVE: Action = { type: 'move', moveIndex: 1 };

function request(rqid = 2) {
  return JSON.stringify({
    rqid,
    side: {
      id: 'p1',
      pokemon: [{ ident: 'p1: A', details: 'A', condition: '100/100', active: true }],
    },
    active: [{
      moves: [{ move: 'Tackle', id: 'tackle', pp: 35, maxpp: 35, target: 'normal', disabled: false }],
    }],
  });
}

function harness(
  choose: (roomId?: string, choice?: string) => boolean,
  options: { action?: Action; choiceWatchMs?: number } = {},
) {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-delivery-'));
  let decisions = 0;
  const sent: Array<{ roomId: string; choice: string }> = [];
  const socket = new EventEmitter();
  const client = Object.assign(socket, {
    choose: (roomId: string, choice: string) => {
      sent.push({ roomId, choice });
      return choose(roomId, choice);
    },
    saveReplay: () => true,
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
      async decide() {
        decisions += 1;
        return { action: options.action ?? MOVE, score: 1, timeMs: 1, fallback: false };
      },
    } as unknown as DecisionClient,
    logDir,
    decisionTimeoutMs: 1000,
    deliveryRetryMs: 5,
    choiceWatchMs: options.choiceWatchMs,
    settleMs: 0,
  });
  return { driver, socket, logDir, sent, decisions: () => decisions };
}

function readLog(logDir: string, room: string): Array<Record<string, unknown>> {
  const file = path.join(logDir, `botalpha-${room}.jsonl`);
  return fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
}

function ended(driver: BattleDriver): Promise<GameSummary> {
  return new Promise(resolve => driver.once('gameEnd', resolve));
}

describe('ladder delivery and timers', () => {
  it('clears a stale turn timer on the next request', async () => {
    const { driver, socket, logDir, decisions } = harness(() => true);
    const room = 'battle-gen9randombattle-1';
    const done = ended(driver);
    socket.emit('line', room, '|player|p1|BotAlpha|1|1100');
    socket.emit('line', room, '|player|p2|Rival|2|1400');
    socket.emit('line', room, '|inactive|BotAlpha has 2 seconds left.');
    socket.emit('line', room, `|request|${request()}`);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(decisions()).toBe(1);
    socket.emit('line', room, '|win|BotAlpha');
    const summary = await done;
    expect(summary.choiceDeliveryFailures).toBe(0);
    const events = readLog(logDir, room);
    const turn = events.find(event => event.type === 'turn' && event.decision !== 'team');
    expect(turn).toMatchObject({ secondsLeft: null, kind: 'turn' });
    expect(events.some(event => event.type === 'timer' && event.secondsLeft === 2 && event.aboutUs === true)).toBe(true);
    expect(driver.roomCount()).toBe(0);
    await driver.stop();
  });

  it('keeps an inactive line that arrives during the request debounce', async () => {
    const { driver, socket, logDir, decisions } = harness(() => true);
    const room = 'battle-gen9randombattle-1';
    const done = ended(driver);
    socket.emit('line', room, '|player|p1|BotAlpha|1|1100');
    socket.emit('line', room, '|player|p2|Rival|2|1400');
    socket.emit('line', room, '|inactive|BotAlpha has 2 seconds left.');
    socket.emit('line', room, `|request|${request()}`);
    await new Promise(resolve => setTimeout(resolve, 5));
    socket.emit('line', room, '|inactive|BotAlpha has 20 seconds left.');
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(decisions()).toBe(1);
    socket.emit('line', room, '|win|BotAlpha');
    await done;
    const turn = readLog(logDir, room).find(event => event.type === 'turn' && event.choice);
    expect(turn).toMatchObject({ secondsLeft: 20 });
    await driver.stop();
  });

  it('logs a choice-delivery failure and retries when choose returns false', async () => {
    let sends = 0;
    const { driver, socket, logDir } = harness(() => {
      sends += 1;
      return sends >= 2;
    });
    const room = 'battle-gen9randombattle-1';
    const done = ended(driver);
    socket.emit('line', room, '|player|p1|BotAlpha|1|1100');
    socket.emit('line', room, '|player|p2|Rival|2|1400');
    socket.emit('line', room, `|request|${request()}`);
    await new Promise(resolve => setTimeout(resolve, 50));
    socket.emit('line', room, '|win|BotAlpha');
    const summary = await done;
    expect(summary.choiceDeliveryFailures).toBe(1);
    const events = readLog(logDir, room);
    const deliveries = events.filter(event => event.type === 'choice-delivery');
    expect(deliveries[0]).toMatchObject({ kind: 'choice-delivery', sent: false, cause: 'socket-closed', retry: 0 });
    expect(deliveries[1]).toMatchObject({ sent: true, cause: 'sent', retry: 1 });
    expect(driver.roomCount()).toBe(0);
    await driver.stop();
  });

  it('emits one no-legal-retry event when the server rejects the only move', async () => {
    const { driver, socket, logDir } = harness(() => true);
    const room = 'battle-gen9randombattle-1';
    const done = ended(driver);
    socket.emit('line', room, '|player|p1|BotAlpha|1|1100');
    socket.emit('line', room, '|player|p2|Rival|2|1400');
    socket.emit('line', room, `|request|${request()}`);
    await new Promise(resolve => setTimeout(resolve, 40));
    socket.emit('line', room, '|error|[Invalid choice] Can\'t move: your Pokémon is trapped');
    socket.emit('line', room, '|error|[Invalid choice] Can\'t move: your Pokémon is trapped');
    socket.emit('line', room, '|win|Rival');
    const summary = await done;
    expect(summary.noLegalRetries).toBe(1);
    const retries = readLog(logDir, room).filter(event => event.cause === 'no-legal-retry');
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ type: 'choice-delivery', kind: 'choice-delivery', sent: false });
    await driver.stop();
  });

  it('attributes a popup by room id and logs ambiguity when it cannot', async () => {
    const { driver, socket, logDir } = harness(() => true);
    const first = 'battle-gen9randombattle-1';
    const second = 'battle-gen9randombattle-10';
    const both = new Promise<void>(resolve => {
      let left = 2;
      driver.on('gameEnd', () => {
        left -= 1;
        if (left === 0) resolve();
      });
    });
    socket.emit('line', first, '|player|p1|BotAlpha|1|1100');
    socket.emit('line', first, '|player|p2|Rival|2|1400');
    socket.emit('line', second, '|player|p1|BotAlpha|1|1100');
    socket.emit('line', second, '|player|p2|Other|2|1200');
    socket.emit('popup', 'Battle timer is ON');
    socket.emit('popup', `saved ${second}`);
    socket.emit('line', first, '|win|BotAlpha');
    socket.emit('line', second, '|win|BotAlpha');
    await both;
    const a = readLog(logDir, first);
    const b = readLog(logDir, second);
    expect(a.filter(event => event.type === 'popup')).toEqual([
      expect.objectContaining({ ambiguous: true, attribution: 'ambiguous', candidates: [first, second] }),
    ]);
    expect(b.filter(event => event.type === 'popup')).toEqual([
      expect.objectContaining({ ambiguous: true, attribution: 'ambiguous' }),
      expect.objectContaining({ ambiguous: false, attribution: 'matched', battleId: second }),
    ]);
    expect(driver.roomCount()).toBe(0);
    await driver.stop();
  });

  it('resends a turn-1 choice when no request or turn follows the send', async () => {
    const room = 'battle-gen9randombattle-2692976066';
    const move: Action = { type: 'move', moveIndex: 2 };
    const { driver, socket, logDir, sent } = harness(() => true, { action: move, choiceWatchMs: 50 });
    const done = ended(driver);
    const body = JSON.stringify({
      rqid: 3,
      side: {
        id: 'p1',
        pokemon: [{ ident: 'p1: A', details: 'A', condition: '100/100', active: true }],
      },
      active: [{
        moves: [
          { move: 'Tackle', id: 'tackle', pp: 35, maxpp: 35, target: 'normal', disabled: false },
          { move: 'Growl', id: 'growl', pp: 40, maxpp: 40, target: 'normal', disabled: false },
        ],
      }],
    });
    socket.emit('line', room, '|player|p1|BotAlpha|1|1100');
    socket.emit('line', room, '|player|p2|Rival|2|1400');
    socket.emit('line', room, `|request|${body}`);
    await new Promise(resolve => setTimeout(resolve, 45));
    expect(sent).toEqual([{ roomId: room, choice: 'move 2|3' }]);
    socket.emit('line', room, '|turn|1');
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(sent).toEqual([
      { roomId: room, choice: 'move 2|3' },
      { roomId: room, choice: 'move 2|3' },
    ]);
    socket.emit('line', room, '|win|BotAlpha');
    await done;
    const deliveries = readLog(logDir, room).filter(event => event.type === 'choice-delivery');
    expect(deliveries[0]).toMatchObject({
      sent: true,
      cause: 'sent',
      rqid: 3,
      choice: 'move 2|3',
      intendedRoomId: room,
      sentRoomId: room,
    });
    expect(deliveries[1]).toMatchObject({
      sent: true,
      cause: 'unconfirmed',
      rqid: 3,
      choice: 'move 2|3',
      retry: 1,
      intendedRoomId: room,
      sentRoomId: room,
    });
    await driver.stop();
  });

  it('resends the same choice and rqid when the clock ticks and the turn does not', async () => {
    const { driver, socket, logDir, sent } = harness(() => true);
    const room = 'battle-gen9randombattle-7005';
    const done = ended(driver);
    socket.emit('line', room, '|player|p1|BotAlpha|1|1100');
    socket.emit('line', room, '|player|p2|Rival|2|1400');
    socket.emit('line', room, `|request|${request(2)}`);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(sent).toEqual([{ roomId: room, choice: 'move 1|2' }]);
    socket.emit('line', room, '|inactive|BotAlpha has 120 seconds left.');
    socket.emit('line', room, '|inactive|Time left: 90 sec this turn | 150 sec total');
    expect(sent).toEqual([
      { roomId: room, choice: 'move 1|2' },
      { roomId: room, choice: 'move 1|2' },
      { roomId: room, choice: 'move 1|2' },
    ]);
    socket.emit('line', room, '|turn|2');
    socket.emit('line', room, '|inactive|BotAlpha has 150 seconds left.');
    expect(sent).toHaveLength(3);
    socket.emit('line', room, '|win|BotAlpha');
    await done;
    const resends = readLog(logDir, room).filter(event => event.cause === 'unconfirmed');
    expect(resends).toHaveLength(2);
    expect(resends[0]).toMatchObject({ rqid: 2, choice: 'move 1|2', sent: true, retry: 1 });
    await driver.stop();
  });

  it('does not send a choice after a newer request replaced its rqid', async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-delivery-'));
    const sent: Array<{ roomId: string; choice: string }> = [];
    const socket = new EventEmitter();
    const client = Object.assign(socket, {
      choose: (roomId: string, choice: string) => {
        sent.push({ roomId, choice });
        return true;
      },
      saveReplay: () => true,
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
        async decide() {
          calls += 1;
          if (calls === 1) await new Promise<void>(resolve => { release = resolve; });
          return { action: MOVE, score: 1, timeMs: 1, fallback: false };
        },
      } as unknown as DecisionClient,
      logDir,
      decisionTimeoutMs: 1000,
      deliveryRetryMs: 5,
      settleMs: 0,
    });
    const room = 'battle-gen9randombattle-7005';
    const done = ended(driver);
    socket.emit('line', room, '|player|p1|BotAlpha|1|1100');
    socket.emit('line', room, '|player|p2|Rival|2|1400');
    socket.emit('line', room, `|request|${request(2)}`);
    await new Promise(resolve => setTimeout(resolve, 30));
    socket.emit('line', room, `|request|${request(5)}`);
    release?.();
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(sent).toEqual([{ roomId: room, choice: 'move 1|5' }]);
    expect(readLog(logDir, room).some(event => event.cause === 'stale-rqid' && event.rqid === 2)).toBe(true);
    socket.emit('line', room, '|win|BotAlpha');
    await done;
    await driver.stop();
  });

  it('keeps interleaved battles on their own room and rqid', async () => {
    const { driver, socket, logDir, sent } = harness(() => true);
    const older = 'battle-gen9randombattle-7005';
    const newer = 'battle-gen9randombattle-7020';
    const both = new Promise<void>(resolve => {
      let left = 2;
      driver.on('gameEnd', () => {
        left -= 1;
        if (left === 0) resolve();
      });
    });
    const payload = [
      `>${older}`,
      '|player|p1|BotAlpha|1|1100',
      '|player|p2|Rival|2|1400',
      `|request|${request(2)}`,
      `>${newer}`,
      '|player|p1|BotAlpha|1|1100',
      '|player|p2|Other|2|1200',
      `|request|${request(5)}`,
      '|init|battle',
    ].join('\n');
    for (const row of roomLines(payload)) socket.emit('line', row.roomid, row.line);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(sent).toEqual([
      { roomId: older, choice: 'move 1|2' },
      { roomId: newer, choice: 'move 1|5' },
    ]);
    const popup = 'uploaded https://replay.pokemonshowdown.com/gen9randombattle-7020-vf14y87snr046p0x7g86l2ffrf1912epw';
    socket.emit('popup', popup);
    socket.emit('line', older, '|win|BotAlpha');
    socket.emit('line', newer, '|win|BotAlpha');
    await both;
    const olderLog = readLog(logDir, older);
    const newerLog = readLog(logDir, newer);
    expect(olderLog.filter(event => event.type === 'popup')).toEqual([]);
    expect(newerLog.filter(event => event.type === 'popup')).toEqual([
      expect.objectContaining({ attribution: 'matched', battleId: newer, ambiguous: false }),
    ]);
    expect(olderLog.filter(event => event.type === 'game_start').map(event => event.battleId)).toEqual([older]);
    socket.emit('line', older, '|player|p1|BotAlpha|1|1100');
    socket.emit('line', older, `|request|${request(9)}`);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(readLog(logDir, older).filter(event => event.type === 'game_start')).toHaveLength(1);
    expect(sent.some(choice => choice.choice.endsWith('|9'))).toBe(false);
    expect(driver.roomCount()).toBe(0);
    await driver.stop();
  });

  it('files a replay popup on the named battle, not the most recently active one', async () => {
    const { driver, socket, logDir } = harness(() => true);
    const first = 'battle-gen9randombattle-7000';
    const middle = 'battle-gen9randombattle-7005';
    const latest = 'battle-gen9randombattle-7020';
    const popups = (room: string) => readLog(logDir, room).filter(event => event.type === 'popup');
    const uploaded = (id: string) =>
      `|popup||html|<p>Your replay has been uploaded! https://replay.pokemonshowdown.com/${id}-vf14y87snr046p0x7g86l2ffrf1912epw</p>`;
    for (const room of [first, middle, latest]) {
      socket.emit('line', room, '|player|p1|BotAlpha|1|1100');
      socket.emit('line', room, '|player|p2|Rival|2|1400');
    }
    socket.emit('popup', uploaded('gen9randombattle-7020'));
    socket.emit('popup', uploaded('gen9randombattle-7000'));
    socket.emit('popup', uploaded('gen9randombattle-7005'));
    socket.emit('line', latest, uploaded('gen9randombattle-7005'));
    const endedFirst = ended(driver);
    socket.emit('line', first, '|win|BotAlpha');
    await endedFirst;
    socket.emit('popup', uploaded('gen9randombattle-7000'));
    for (const room of [middle, latest]) socket.emit('line', room, '|win|BotAlpha');
    await new Promise<void>(resolve => {
      let left = 2;
      driver.on('gameEnd', () => {
        left -= 1;
        if (left === 0) resolve();
      });
    });
    expect(popups(first).map(event => event.message)).toEqual([
      expect.stringContaining('gen9randombattle-7000-'),
    ]);
    expect(popups(middle).map(event => event.message)).toEqual([
      expect.stringContaining('gen9randombattle-7005-'),
    ]);
    expect(popups(latest).map(event => event.message)).toEqual([
      expect.stringContaining('gen9randombattle-7020-'),
    ]);
    expect(popups(latest).some(event => String(event.message).includes('2692967000') || String(event.message).includes('gen9randombattle-7000'))).toBe(false);
    expect(popups(middle).some(event => String(event.message).includes('gen9randombattle-7020'))).toBe(false);
    const latestReplay = fs.readFileSync(
      path.join(logDir, 'replays', 'botalpha-battle-gen9randombattle-7020.log'),
      'utf8',
    );
    expect(latestReplay).not.toContain('gen9randombattle-7005');
    expect(latestReplay).not.toContain('gen9randombattle-7000');
    await driver.stop();
  });
});
