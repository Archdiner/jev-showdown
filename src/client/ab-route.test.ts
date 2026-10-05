import { loadConfig } from '../config/load.js';
import {
  AbSession,
  assignArm,
  battleBucket,
  buildPlan,
  CHALLENGER_LOSS_STREAK,
  parseAbSpec,
  preflightCanaries,
  resolveAbPlan,
  shareUnits,
} from './ab-route.js';
import { ladderConfigId, ladderPolicy, policyHash } from './ladder-engine.js';

const champion = {
  configId: 'champion-exact-1ply',
  configHash: 'champ-hash',
  configPath: null,
  engine: 'search' as const,
};

function challenger(id: string, share: number, engine: 'search' | 'max-damage' = 'search') {
  return {
    configId: id,
    configHash: `${id}-hash`,
    configPath: `${id}.yaml`,
    engine,
    share,
  };
}

function plan(share = 0.25) {
  return buildPlan(champion, [challenger('depth-2', share)]);
}

describe('ab routing', () => {
  it('parses a config path and an engine profile share', () => {
    expect(parseAbSpec('configs/panel/maxdamage.yaml:0.2')).toEqual({
      ref: 'configs/panel/maxdamage.yaml',
      share: 0.2,
    });
    expect(parseAbSpec('max-damage:1')).toEqual({ ref: 'max-damage', share: 1 });
    expect(() => parseAbSpec('max-damage')).toThrow(/<config>:<share>/);
    expect(() => parseAbSpec('max-damage:0')).toThrow(/fraction/);
    expect(() => parseAbSpec('max-damage:1.5')).toThrow(/fraction/);
  });

  it('gives the champion the remainder and rejects shares that sum past 1', () => {
    const arms = plan(0.25).arms;
    expect(arms.map(arm => [arm.role, arm.share])).toEqual([
      ['champion', 0.75],
      ['challenger', 0.25],
    ]);
    expect(shareUnits(0.1) + shareUnits(0.2) + shareUnits(0.7)).toBe(1_000_000);
    expect(() => buildPlan(champion, [challenger('a', 0.6), challenger('b', 0.5)])).toThrow(/at most 1/);
    expect(() => buildPlan(champion, [challenger('champion-exact-1ply', 0.2)])).toThrow(/already/);
  });

  it('assigns a battle from a hash of its id and keeps that arm', () => {
    const arms = plan(0.5).arms;
    const first = assignArm('battle-gen9randombattle-1', arms, new Set());
    expect(battleBucket('battle-gen9randombattle-1')).toBeGreaterThanOrEqual(0);
    expect(battleBucket('battle-gen9randombattle-1')).toBeLessThan(1);
    expect(assignArm('battle-gen9randombattle-1', arms, new Set())).toEqual(first);
    const counts = { champion: 0, challenger: 0 };
    for (let i = 0; i < 4000; i++) {
      const arm = assignArm(`battle-ab-${i}`, arms, new Set());
      counts[arm.role] += 1;
    }
    expect(counts.challenger / 4000).toBeGreaterThan(0.45);
    expect(counts.challenger / 4000).toBeLessThan(0.55);
    expect(counts.champion / 4000).toBeGreaterThan(0.45);
  });

  it('sends a pulled challenger to the champion and leaves champion games alone', () => {
    const arms = plan(0.5).arms;
    let challengerId = '';
    let championId = '';
    for (let i = 0; i < 200 && (!challengerId || !championId); i++) {
      const id = `battle-pull-${i}`;
      const arm = assignArm(id, arms, new Set());
      if (arm.role === 'challenger' && !challengerId) challengerId = id;
      if (arm.role === 'champion' && !championId) championId = id;
    }
    const pulled = new Set(['depth-2']);
    const redirected = assignArm(challengerId, arms, pulled);
    expect(redirected.role).toBe('champion');
    expect(redirected.redirected).toBe(true);
    expect(redirected.configId).toBe('champion-exact-1ply');
    expect(assignArm(championId, arms, pulled).role).toBe('champion');
    expect(assignArm(championId, arms, pulled).redirected).toBe(false);
  });

  it('pulls a challenger on an invalid move, a timer loss, a crash, or four losses', () => {
    const session = new AbSession(plan());
    const id = firstId(session, 'challenger');
    expect(session.noteFault(id, 'invalid-move')?.reason).toBe('invalid-move');
    expect(session.noteFault(id, 'invalid-move')).toBeNull();
    expect(session.isPulled('depth-2')).toBe(true);
    const fresh = new AbSession(plan());
    expect(fresh.assign(firstId(fresh, 'challenger')).role).toBe('challenger');
    expect(session.assign(nextFresh(session, 'challenger')).role).toBe('champion');

    const timer = new AbSession(plan());
    const timerId = firstId(timer, 'challenger');
    expect(timer.noteGame(fact(timerId, { endReason: 'our-timer', outcome: 'loss' }))?.reason).toBe('timer-loss');

    const crash = new AbSession(plan());
    const crashId = firstId(crash, 'challenger');
    expect(crash.noteGame(fact(crashId, { crashes: 1, outcome: 'loss', endReason: 'ko' }))?.reason).toBe('crash');

    const streak = new AbSession(plan());
    for (let i = 0; i < CHALLENGER_LOSS_STREAK - 1; i++) {
      const battleId = nextFresh(streak, 'challenger');
      expect(streak.noteGame(fact(battleId, { outcome: 'loss', endReason: 'ko' }))).toBeNull();
    }
    const fourth = nextFresh(streak, 'challenger');
    expect(streak.noteGame(fact(fourth, { outcome: 'loss', endReason: 'ko' }))?.reason).toBe('loss-streak');
    expect(streak.incidents).toHaveLength(1);
  });

  it('resets the loss streak on a win and does not pull the champion', () => {
    const session = new AbSession(plan());
    for (let i = 0; i < 3; i++) {
      session.noteGame(fact(nextFresh(session, 'challenger'), { outcome: 'loss', endReason: 'ko' }));
    }
    session.noteGame(fact(nextFresh(session, 'challenger'), { outcome: 'win', endReason: 'ko' }));
    for (let i = 0; i < 3; i++) {
      expect(session.noteGame(fact(nextFresh(session, 'challenger'), { outcome: 'loss', endReason: 'ko' }))).toBeNull();
    }
    const championId = firstId(session, 'champion');
    expect(session.noteFault(championId, 'invalid-move')).toBeNull();
    expect(session.noteGame(fact(championId, {
      outcome: 'loss',
      endReason: 'our-timer',
      invalidChoices: 2,
      crashes: 1,
      role: 'champion',
      configId: champion.configId,
    }))).toBeNull();
    expect(session.pulledIds()).toEqual([]);
    const ghost = new AbSession(plan());
    const ghostId = firstId(ghost, 'challenger');
    expect(ghost.noteGame(fact(ghostId, {
      outcome: 'tie',
      endReason: 'disconnect',
      invalidChoices: 1,
      crashes: 1,
      phantom: true,
    }))).toBeNull();
    expect(ghost.isPulled('depth-2')).toBe(false);
  });

  it('loads a yaml challenger and lists a preflight canary for each arm', () => {
    const loaded = loadConfig('configs/panel/maxdamage.yaml');
    const resolved = resolveAbPlan({
      champion,
      hostEngine: 'search',
      specs: ['configs/panel/maxdamage.yaml:0.2', 'max-damage:0.1'],
    });
    expect(resolved.arms.map(arm => arm.role)).toEqual(['champion', 'challenger', 'challenger']);
    expect(resolved.arms[1].configId).toBe(loaded.configId);
    expect(resolved.arms[1].configPath).toMatch(/maxdamage\.yaml$/);
    expect(resolved.arms[1].share).toBe(0.2);
    expect(resolved.arms[0].share).toBe(0.7);
    expect(resolved.arms[2].configId).toBe(ladderConfigId('max-damage'));
    expect(resolved.arms[2].configHash).toBe(policyHash(ladderPolicy('max-damage')));
    expect(resolved.arms[2].configPath).toBeNull();
    const canaries = preflightCanaries(resolved);
    expect(canaries).toHaveLength(3);
    expect(canaries.map(canary => canary.configId)).toEqual(resolved.arms.map(arm => arm.configId));
  });
});

function firstId(session: AbSession, role: 'champion' | 'challenger'): string {
  return nextFresh(session, role);
}

function nextFresh(session: AbSession, role: 'champion' | 'challenger'): string {
  for (let i = 0; i < 5000; i++) {
    const id = `battle-fact-${role}-${session.incidents.length}-${i}-${Math.random()}`;
    const arm = assignArm(id, session.plan.arms, new Set());
    if (arm.role !== role) continue;
    if (session.isPulled(arm.configId) && role === 'challenger') return id;
    session.assign(id);
    return id;
  }
  throw new Error(`no ${role} id`);
}

function fact(battleId: string, extra: Partial<{
  outcome: 'win' | 'loss' | 'tie';
  endReason: string;
  invalidChoices: number;
  crashes: number;
  role: 'champion' | 'challenger';
  configId: string;
  phantom: boolean;
}>): {
  battleId: string;
  configId: string;
  role: 'champion' | 'challenger';
  outcome: 'win' | 'loss' | 'tie';
  endReason: string;
  invalidChoices: number;
  crashes: number;
  phantom?: boolean;
} {
  return {
    battleId,
    configId: extra.configId ?? 'depth-2',
    role: extra.role ?? 'challenger',
    outcome: extra.outcome ?? 'loss',
    endReason: extra.endReason ?? 'ko',
    invalidChoices: extra.invalidChoices ?? 0,
    crashes: extra.crashes ?? 0,
    phantom: extra.phantom,
  };
}
