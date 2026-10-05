import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DecisionClient } from './decision-client.js';
import { BattleDriver } from './battle-driver.js';
import { ourClockUpdate } from './inactive-clock.js';
import { ShowdownClient } from './showdown-client.js';
import { dataLoader } from '../data/data-loader.js';
import { gen9RandomBattle } from '../formats/gen9-randombattle.js';
import { BotConfig } from '../types/index.js';

describe('inactive clock', () => {
  const user = 'BotAlpha';

  it('reads the private per-turn line and ignores the total and grace', () => {
    expect(ourClockUpdate(
      '|inactive|Time left: 150 sec this turn | 150 sec total | 60 sec grace',
      user,
    )).toBe(150);
    expect(ourClockUpdate('|inactive|Time left: 42 sec this turn | 140 sec total', user)).toBe(42);
    expect(ourClockUpdate('|inactive|Time left: 7 seconds this turn | 7 sec total', user)).toBe(7);
  });

  it('keeps our named clock and ignores the opponent', () => {
    expect(ourClockUpdate('|inactive|BotAlpha has 20 seconds left.', user)).toBe(20);
    expect(ourClockUpdate('|inactive|Bot Alpha has 18 seconds left this turn.', user)).toBe(18);
    expect(ourClockUpdate('|inactive|You have 11 seconds left.', user)).toBe(11);
    expect(ourClockUpdate('|inactive|Foe has 9 seconds left.', user)).toBeUndefined();
    expect(ourClockUpdate('|inactive|Your opponent has 9 seconds left.', user)).toBeUndefined();
  });

  it('clears the clock when the timer is turned off and ignores status text', () => {
    expect(ourClockUpdate('|inactiveoff|Battle timer is now OFF.', user)).toBeNull();
    expect(ourClockUpdate(
      '|inactive|Battle timer is ON: inactive players will automatically lose when time\'s up.',
      user,
    )).toBeUndefined();
    expect(ourClockUpdate('|inactive|Foe has 60 seconds to reconnect!', user)).toBeUndefined();
    expect(ourClockUpdate('|request|{}', user)).toBeUndefined();
  });
});

describe('ladder timer request', () => {
  beforeAll(async () => {
    // data/*.json is gitignored. Other suites write these files, but this
    // file can run first on a clean CI checkout.
    const dataDir = path.join(process.cwd(), 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const setsPath = path.join(dataDir, 'gen9-sets.json');
    const statsPath = path.join(dataDir, 'gen9-stats.json');
    if (!fs.existsSync(setsPath)) {
      fs.writeFileSync(setsPath, JSON.stringify({ Pikachu: { level: 88 } }));
    }
    if (!fs.existsSync(statsPath)) {
      fs.writeFileSync(statsPath, JSON.stringify({
        Pikachu: {
          level: 88,
          abilities: { Static: 0.9, 'Lightning Rod': 0.1 },
          items: { 'Light Ball': 1.0 },
          roles: {
            'Fast Attacker': {
              weight: 0.8,
              moves: { Thunderbolt: 1.0, 'Volt Switch': 0.8 },
              items: { 'Light Ball': 1.0 },
            },
            Wallbreaker: {
              weight: 0.2,
              moves: { Thunderbolt: 1.0, Surf: 0.5 },
              items: { 'Light Ball': 1.0 },
            },
          },
        },
      }));
    }
    await dataLoader.load();
  });

  const config: BotConfig = {
    searchTimeMs: 200,
    searchIterations: 1,
    explorationConstant: 1.4,
    sampledWorlds: 1,
    useTeraHeuristic: true,
    useLLMPrior: false,
  };

  function harness() {
    const sent: string[] = [];
    const client = new ShowdownClient({
      server: 'ws://127.0.0.1:1/showdown/websocket',
      username: 'BotAlpha',
      local: true,
    });
    client.send = (message: string) => {
      sent.push(message);
      return true;
    };
    const decisions = new DecisionClient({
      config,
      engine: 'search',
      timeoutMs: 500,
      workers: 1,
    });
    decisions.openBattle = () => {};
    decisions.closeBattle = () => {};
    decisions.decide = async () => ({
      action: { type: 'move', moveIndex: 1 },
      score: 1,
      timeMs: 1,
      fallback: false,
    });
    const driver = new BattleDriver({
      client,
      username: 'BotAlpha',
      format: gen9RandomBattle,
      engineName: 'search',
      decisions,
      logDir: path.join(os.tmpdir(), 'jev-inactive-clock'),
      decisionTimeoutMs: 500,
    });
    return { sent, client, driver };
  }

  const request = {
    rqid: 2,
    side: {
      id: 'p1',
      pokemon: [
        { ident: 'p1: A', details: 'Pikachu', condition: '100/100', active: true },
        { ident: 'p1: B', details: 'B', condition: '80/100', active: false },
      ],
    },
    active: [{
      moves: [
        { move: 'Tackle', id: 'tackle', pp: 35, maxpp: 35, target: 'normal', disabled: false },
      ],
    }],
  };

  it('turns the timer on at battle start and records the clock on the decision', async () => {
    const { sent, client, driver } = harness();
    const decisions: Array<{ secondsLeft: number | null }> = [];
    driver.on('decision', (sample: { secondsLeft: number | null }) => {
      decisions.push(sample);
    });
    const room = 'battle-gen9randombattle-1';
    client.emit('line', room, '|player|p1|BotAlpha|bot|');
    client.emit('line', room, `|request|${JSON.stringify(request)}`);
    client.emit('line', room, '|inactive|Time left: 42 sec this turn | 140 sec total | 60 sec grace');
    client.emit('line', room, '|inactive|Foe has 9 seconds left.');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(sent).toEqual([`${room}|/timer on`]);
    expect(sent.join('\n')).not.toMatch(/forfeit/i);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].secondsLeft).toBe(42);

    client.emit('line', room, '|win|BotAlpha');
    await new Promise(resolve => setTimeout(resolve, 2100));
    await driver.stop();
  }, 10_000);
});
