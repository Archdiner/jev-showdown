import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dataLoader } from '../data/data-loader.js';
import { gen9RandomBattle } from '../formats/gen9-randombattle.js';
import { AbSession, assignArm, resolveAbPlan } from './ab-route.js';
import { BattleDriver } from './battle-driver.js';
import { DecisionClient } from './decision-client.js';
import { buildLadderGameRecord } from './game-record.js';
import { ladderConfigId } from './ladder-engine.js';
import { ShowdownClient } from './showdown-client.js';

const champion = {
  configId: ladderConfigId('search'),
  configHash: 'champ-hash',
  configPath: null,
  engine: 'search' as const,
};

describe('ab soak', () => {
  const loader = dataLoader as unknown as { loaded: boolean; stats: Record<string, unknown> };
  const prior = { loaded: loader.loaded, stats: loader.stats };

  beforeAll(() => {
    loader.loaded = true;
    loader.stats = loader.stats ?? {};
  });

  afterAll(() => {
    loader.loaded = prior.loaded;
    loader.stats = prior.stats;
  });

  it('routes three concurrent battles across two configs', async () => {
    const plan = resolveAbPlan({
      champion,
      hostEngine: 'search',
      specs: ['configs/panel/maxdamage.yaml:0.5'],
    });
    expect(plan.arms).toHaveLength(2);
    const session = new AbSession(plan, () => undefined);
    const ids = cover(plan, 3);
    const assigned = await Promise.all(ids.map(async id => {
      await new Promise(resolve => setImmediate(resolve));
      return session.assign(id);
    }));
    expect(new Set(assigned.map(arm => arm.configId)).size).toBe(2);
    expect(assigned.every(arm => arm.role === 'champion' || arm.role === 'challenger')).toBe(true);

    const records = await Promise.all(assigned.map(async (arm, index) => {
      await new Promise(resolve => setImmediate(resolve));
      return buildLadderGameRecord({
        startedAt: 1_000,
        ts: 2_000,
        battleId: ids[index],
        format: 'gen9randombattle',
        username: 'BotAlpha',
        opponent: 'Rival',
        opponentRating: 1400,
        lines: ['|win|BotAlpha'],
        winner: 'BotAlpha',
        turns: 3,
        invalidChoices: 0,
        crashes: 0,
        fallbacks: 0,
        mismatches: 0,
        eloBefore: 1000,
        eloAfter: 1016,
        gxe: null,
        latencies: [],
        minTimerMarginSec: null,
        engine: arm.engine,
        configId: arm.configId,
        configHash: arm.configHash,
        gitSha: 'abc',
        concurrency: 3,
        replayId: null,
        replayUrl: null,
        localReplayPath: null,
        localServer: true,
        disconnected: false,
        logPath: 'battle.jsonl',
        role: arm.role,
        share: arm.share,
        configPath: arm.configPath ?? undefined,
      });
    }));
    expect(records.map(record => record.concurrency)).toEqual([3, 3, 3]);
    for (const record of records) {
      expect(record.role === 'champion' || record.role === 'challenger').toBe(true);
      expect(record.share).toBeGreaterThan(0);
      expect(record.configId).toBeTruthy();
    }
    expect(new Set(records.map(record => record.configId)).size).toBe(2);
  });

  it('keeps one driver for both configs and pulls the challenger after an invalid move', async () => {
    const plan = resolveAbPlan({
      champion,
      hostEngine: 'search',
      specs: ['configs/panel/maxdamage.yaml:0.5'],
    });
    const incidents: string[] = [];
    const session = new AbSession(plan, incident => {
      incidents.push(incident.reason);
    });
    const challengerId = findId(plan, 'challenger');
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-ab-soak-'));
    const opened: Array<{ battleId: string; configPath: string | null; engine: string }> = [];
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
        openBattle(battleId: string, route?: { configPath: string | null; engine: string }) {
          opened.push({
            battleId,
            configPath: route?.configPath ?? null,
            engine: route?.engine ?? 'search',
          });
        },
        closeBattle() { /* unused */ },
        async stop() { /* unused */ },
      } as unknown as DecisionClient,
      logDir,
      decisionTimeoutMs: 1000,
      settleMs: 0,
      concurrency: 3,
      localServer: true,
      configId: champion.configId,
      configHash: champion.configHash,
      gitSha: 'abc',
      routeBattle: battleId => session.assign(battleId),
      onBattleFault: (battleId, fault) => session.noteFault(battleId, fault),
      onGame: record => session.noteGame(record),
    });

    const ended = new Promise<import('./game-record.js').LadderGameRecord>(resolve => driver.on('gameEnd', resolve));
    socket.emit('line', challengerId, '|player|p1|BotAlpha|1|1200');
    socket.emit('line', challengerId, '|player|p2|Rival|2|1400');
    socket.emit('line', challengerId, '|error|[Invalid choice] move 9');
    socket.emit('line', challengerId, '|win|Rival');
    const summary = await ended;

    expect(opened).toEqual([{
      battleId: challengerId,
      configPath: plan.arms[1].configPath,
      engine: 'max-damage',
    }]);
    expect(summary.role).toBe('challenger');
    expect(summary.share).toBe(0.5);
    expect(summary.configId).toBe(plan.arms[1].configId);
    expect(summary.invalidChoices).toBe(1);
    expect(summary.concurrency).toBe(3);
    expect(incidents).toEqual(['invalid-move']);
    expect(session.isPulled(plan.arms[1].configId)).toBe(true);

    const stored = JSON.parse(fs.readFileSync(path.join(logDir, 'games.jsonl'), 'utf8'));
    expect(stored.role).toBe('challenger');
    expect(stored.share).toBe(0.5);
    expect(stored.configId).toBe(plan.arms[1].configId);

    const another = findId(plan, 'challenger', new Set([challengerId]));
    expect(session.assign(another).role).toBe('champion');
    expect(session.assign(another).configId).toBe(champion.configId);
    await driver.stop();
  });
});

function cover(plan: ReturnType<typeof resolveAbPlan>, count: number): string[] {
  const championIds: string[] = [];
  const challengerIds: string[] = [];
  for (let i = 0; championIds.length < count || challengerIds.length < count; i++) {
    const id = `battle-soak-${i}`;
    const arm = assignArm(id, plan.arms, new Set());
    if (arm.role === 'champion') championIds.push(id);
    else challengerIds.push(id);
    if (i > 10000) throw new Error('could not cover both configs');
  }
  return [championIds[0], challengerIds[0], challengerIds[1]];
}

function findId(
  plan: ReturnType<typeof resolveAbPlan>,
  role: 'champion' | 'challenger',
  skip: ReadonlySet<string> = new Set(),
): string {
  for (let i = 0; i < 10000; i++) {
    const id = `battle-soak-fault-${i}`;
    if (skip.has(id)) continue;
    if (assignArm(id, plan.arms, new Set()).role === role) return id;
  }
  throw new Error(`no ${role} battle id`);
}
