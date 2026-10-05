import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BattleDriver, GameSummary } from './battle-driver.js';
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

function harness(choose: () => boolean) {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-delivery-'));
  let decisions = 0;
  const socket = new EventEmitter();
  const client = Object.assign(socket, {
    choose: () => choose(),
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
        return { action: MOVE, score: 1, timeMs: 1, fallback: false };
      },
    } as unknown as DecisionClient,
    logDir,
    decisionTimeoutMs: 1000,
    deliveryRetryMs: 5,
    settleMs: 0,
  });
  return { driver, socket, logDir, decisions: () => decisions };
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
});
