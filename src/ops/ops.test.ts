import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { allocate, nextCircuit } from './allocate.js';
import { countsFromLiveGames, loadVariantPool, thompsonDraw } from './variants.js';
import { runAnalyst } from './analyst.js';
import { openDb } from './db.js';
import { runFactory } from './factory.js';
import { bootstrapChampion, diagnosticsForConfig, exactDiagnosticsConfig, judge, reviewProposals, sprt } from './gatekeeper.js';
import type { GameResult } from '../bench/game.js';
import { loadConfig } from '../config/load.js';
import { liveProposalAllowed, tallySide } from './sprt.js';
import { completeJob, claimNext, enqueue, listJobs } from './queue.js';
import { readLabels } from './labels-read.js';
import { startLocalServer } from './local-server.js';
import { liveSlotLimit, recordedRating, rememberRating, runLive, seatForChoice } from './live.js';
import { appendJsonl, opsPaths, readJsonl } from './paths.js';
import { observeLog, emptyCounts, countsToPriors } from './priors.js';
import { dailyReport } from './report.js';
import { statusReport } from './status.js';

function tempPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-ops-'));
  const prior = process.env.GRAPH_DB;
  const ops = process.env.OPS_DIR;
  delete process.env.GRAPH_DB;
  delete process.env.OPS_DIR;
  const paths = opsPaths(root);
  if (prior === undefined) delete process.env.GRAPH_DB;
  else process.env.GRAPH_DB = prior;
  if (ops === undefined) delete process.env.OPS_DIR;
  else process.env.OPS_DIR = ops;
  return paths;
}

describe('ops boundaries', () => {
  test('only the gatekeeper module imports the label writer', () => {
    const dir = path.join(process.cwd(), 'src', 'ops');
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file === 'labels.ts' || file === 'gatekeeper.ts') continue;
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(text).not.toContain("from './labels.js'");
      expect(text).not.toContain('writeChampion');
      expect(text).not.toContain('writeLiveApproved');
    }
    expect(fs.readFileSync(path.join(dir, 'gatekeeper.ts'), 'utf8')).toContain("from './labels.js'");
  });
});

describe('traffic and circuit breakers', () => {
  const champion = { configId: 'champ', configPath: 'configs/champion.yaml', labels: ['champion', 'live-approved'] };
  const explorer = { configId: 'exp', configPath: 'configs/challengers/sample-search.yaml', labels: ['live-approved'] };

  test('the champion gets the non-explore share', () => {
    expect(allocate([champion, explorer], () => 0.5, 0.15)?.configId).toBe('champ');
    expect(allocate([champion, explorer], () => 0.05, 0.15)?.configId).toBe('exp');
    expect(allocate([{ ...champion, pulled: true }, explorer], () => 0.9)?.configId).toBe('exp');
    expect(allocate([{ ...champion, pulled: true }], () => 0.1)).toBeNull();
  });

  test('consecutive losses or a rating drop pull a config', () => {
    let state = nextCircuit(undefined, 'loss', 1500, { maxLosses: 3, maxDrop: 40, window: 5 });
    state = nextCircuit(state, 'loss', 1490, { maxLosses: 3, maxDrop: 40, window: 5 });
    expect(state.pulled).toBe(false);
    state = nextCircuit(state, 'loss', 1480, { maxLosses: 3, maxDrop: 40, window: 5 });
    expect(state.pulled).toBe(true);
    expect(state.reason).toContain('consecutive');

    const dropped = nextCircuit(
      { consecutiveLosses: 0, ratings: [1600], pulled: false },
      'loss',
      1500,
      { maxLosses: 5, maxDrop: 40, window: 5 }
    );
    expect(dropped.pulled).toBe(true);
    expect(dropped.reason).toContain('rating drop');
  });

  test('a missing rating is not stored as 1000 and does not move the window', () => {
    const held: { rating?: number; gxe?: number } = { rating: 1400, gxe: 60 };
    rememberRating(held, { after: 1412, gxe: null });
    expect(held.rating).toBe(1412);
    expect(held.gxe).toBeUndefined();
    expect(recordedRating(undefined, undefined)).toEqual({ rating: null, gxe: null });
    expect(recordedRating(held.rating, held.gxe)).toEqual({ rating: 1412, gxe: null });

    const state = nextCircuit(
      { consecutiveLosses: 0, ratings: [1400], pulled: false },
      'loss',
      null,
      { maxLosses: 5, maxDrop: 40, window: 5 },
    );
    expect(state.ratings).toEqual([1400]);
    expect(state.consecutiveLosses).toBe(1);
    expect(state.pulled).toBe(false);
  });
});

describe('variant thompson sampling', () => {
  test('an empty pool draws nothing and a single arm is returned', () => {
    expect(thompsonDraw([], {}, () => 0.5)).toBeNull();
    expect(thompsonDraw([{ id: 'switch-depth2' }], {}, () => 0.1)).toBe('switch-depth2');
    const paths = tempPaths();
    expect(loadVariantPool(paths)).toEqual([]);
    fs.writeFileSync(paths.variants, '{');
    expect(loadVariantPool(paths)).toEqual([]);
    fs.writeFileSync(paths.variants, JSON.stringify({
      variants: [
        { id: 'switch-depth2', alpha: 1, beta: 1 },
        { id: 'switch-depth2' },
        { id: 'llm-blocks', alpha: 2, beta: 1 },
        { id: '' },
      ],
    }));
    expect(loadVariantPool(paths).map(arm => arm.id)).toEqual(['switch-depth2', 'llm-blocks']);
  });

  test('wins pull later draws toward that arm', () => {
    const arms = [{ id: 'a' }, { id: 'b' }];
    const counts = countsFromLiveGames([
      { variantId: 'a', winner: 'win' },
      { variantId: 'a', winner: 'win' },
      { variantId: 'a', winner: 'win' },
      { variantId: 'a', winner: 'tie' },
      { variantId: 'b', winner: 'loss' },
      { variantId: 'b', winner: 'loss' },
      { variantId: 'b', winner: 'loss' },
    ]);
    expect(counts.a).toEqual({ wins: 3, losses: 0 });
    expect(counts.b).toEqual({ wins: 0, losses: 3 });
    const rng = mulberry32(7);
    let picks = 0;
    const draws = 200;
    for (let i = 0; i < draws; i++) {
      if (thompsonDraw(arms, counts, rng) === 'a') picks++;
    }
    expect(picks).toBeGreaterThan(draws * 0.8);
  });
});

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('queue', () => {
  test('enqueue is idempotent and a finished job is not claimed again', () => {
    const paths = tempPaths();
    const spec = { kind: 'position-replay' as const, positionId: 'missing', labelDepth: 1 };
    const first = enqueue(paths, spec);
    const second = enqueue(paths, spec);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    const job = claimNext(paths);
    expect(job?.id).toBe(first.id);
    expect(claimNext(paths)).toBeNull();
    completeJob(paths, first.id, { resultId: 'result-1', status: 'done' });
    expect(claimNext(paths)).toBeNull();
    expect(listJobs(paths)).toHaveLength(1);
  });
});

describe('gatekeeper labels', () => {
  test('SPRT plus a full diagnostic pass is required', () => {
    expect(sprt(250, 100)).toBe('promote');
    expect(sprt(1, 1)).toBe('continue');
    expect(sprt(100, 250)).toBe('reject');

    const paths = tempPaths();
    const rejected = judge(paths, {
      configPath: 'configs/champion.yaml',
      action: 'live-approved',
      wins: 250,
      losses: 100,
      invalid: 0,
      crashes: 0,
      diagnostics: { passed: 20, failed: 1, total: 21 },
    });
    expect(rejected.labeled).toBe(false);
    expect(labelsOf(paths)).toHaveLength(0);

    const approved = judge(paths, {
      configPath: 'configs/champion.yaml',
      action: 'champion',
      wins: 250,
      losses: 100,
      invalid: 0,
      crashes: 0,
      diagnostics: { passed: 21, failed: 0, total: 21 },
    });
    expect(approved.labeled).toBe(true);
    const labels = labelsOf(paths);
    expect(labels[0].labels).toEqual(expect.arrayContaining(['champion', 'live-approved']));
  });

  test('bootstrap does not label a champion that has not played', () => {
    const paths = tempPaths();
    const verdict = bootstrapChampion(paths, 'configs/champion.yaml', () => ({ passed: 22, failed: 0, total: 22 }));
    expect(verdict.labeled).toBe(false);
    expect(verdict.sprt).toBe('continue');
    expect(verdict.reason).toContain('no paired games');
    expect(labelsOf(paths)).toHaveLength(0);
  });

  test('a random config does not inherit the exact diagnostic suite', () => {
    const random = loadConfig(path.join(process.cwd(), 'configs/panel/random.yaml'));
    expect(exactDiagnosticsConfig(random)).toBeNull();
    expect(diagnosticsForConfig(random)).toEqual({ passed: 0, failed: 1, total: 1 });
    const champion = loadConfig(path.join(process.cwd(), 'configs/champion.yaml'));
    expect(exactDiagnosticsConfig(champion)?.samples).toBe(champion.config.search.params.samples);
    expect(exactDiagnosticsConfig(champion)?.depth).toBe(1);
  });

  test('review keeps playing until SPRT promotes and ignores the opponent invalid count', async () => {
    const paths = tempPaths();
    const champion = loadConfig(path.join(process.cwd(), 'configs/champion.yaml'));
    enqueue(paths, { kind: 'challenger', challenger: 'configs/panel/random.yaml' });
    const job = claimNext(paths);
    expect(job).not.toBeNull();
    completeJob(paths, job!.id, {
      status: 'done',
      proposal: {
        action: 'live-approved',
        configPath: 'configs/panel/random.yaml',
        configId: 'pending',
        summary: 'scripted',
      },
    });
    let calls = 0;
    const verdicts = await reviewProposals(paths, {
      batch: 50,
      maxGames: 1200,
      diagnostics: () => ({ passed: 1, failed: 0, total: 1 }),
      play: async (a, b, games) => {
        calls += 1;
        expect(b.configId).toBe(champion.configId);
        return Array.from({ length: games }, (_, index) => scriptedGame(index, 'p1', a.configId, b.configId, { p2Invalid: 5 }));
      },
    });
    expect(calls).toBe(3);
    expect(verdicts[0].labeled).toBe(true);
    expect(verdicts[0].sprt).toBe('promote');
  });

  test('a short even sample stays unlabeled, and a crash blocks a label', async () => {
    const paths = tempPaths();
    enqueue(paths, { kind: 'challenger', challenger: 'configs/panel/random.yaml' });
    const job = claimNext(paths);
    completeJob(paths, job!.id, {
      status: 'done',
      proposal: {
        action: 'live-approved',
        configPath: 'configs/panel/random.yaml',
        configId: 'pending',
        summary: 'scripted',
      },
    });
    let calls = 0;
    const continued = await reviewProposals(paths, {
      batch: 2,
      maxGames: 4,
      diagnostics: () => ({ passed: 1, failed: 0, total: 1 }),
      play: async (a, b) => {
        calls += 1;
        return [0, 1].map(index => scriptedGame(index, index === 0 ? 'p1' : 'p2', a.configId, b.configId));
      },
    });
    expect(calls).toBe(2);
    expect(continued[0].sprt).toBe('continue');
    expect(continued[0].labeled).toBe(false);

    const again = tempPaths();
    enqueue(again, { kind: 'challenger', challenger: 'configs/panel/random.yaml', games: 8 });
    const crashedJob = claimNext(again);
    completeJob(again, crashedJob!.id, {
      status: 'done',
      proposal: {
        action: 'live-approved',
        configPath: 'configs/panel/random.yaml',
        configId: 'pending',
        summary: 'scripted',
      },
    });
    const crashed = await reviewProposals(again, {
      batch: 150,
      maxGames: 150,
      diagnostics: () => ({ passed: 1, failed: 0, total: 1 }),
      play: async (a, b, games) => Array.from({ length: games }, (_, index) => (
        scriptedGame(index, 'p1', a.configId, b.configId, { crashed: true })
      )),
    });
    expect(crashed[0].sprt).toBe('promote');
    expect(crashed[0].labeled).toBe(false);
    expect(crashed[0].reason).toContain('crashes=');
  });
});

describe('factory proposals', () => {
  test('four games cannot propose a live label, and a tie is half', () => {
    expect(liveProposalAllowed(3, 1, 0)).toBe(false);
    expect(liveProposalAllowed(4, 0, 0)).toBe(false);
    expect(liveProposalAllowed(250, 100, 0)).toBe(true);
    expect(liveProposalAllowed(250, 100, 1)).toBe(false);
    expect(sprt(117, 33)).toBe('continue');
    expect(tallySide([{
      winner: 'tie',
      p1Id: 'a',
      p2Id: 'b',
      p1Invalid: 0,
      p2Invalid: 4,
      crashed: true,
    }], 'a')).toEqual({ wins: 0.5, losses: 0.5, invalid: 0, crashes: 1 });
  });
});

describe('live seat', () => {
  test('an unknown seat chooses p1 and does not record that guess', () => {
    expect(seatForChoice(undefined, undefined)).toEqual({ choice: 'p1', persist: null });
    expect(seatForChoice('p2', undefined)).toEqual({ choice: 'p2', persist: 'p2' });
    expect(seatForChoice(undefined, 'p2')).toEqual({ choice: 'p2', persist: 'p2' });
    expect(seatForChoice('nope', 'p1')).toEqual({ choice: 'p1', persist: 'p1' });
  });
});

describe('analyst', () => {
  const savedGateway = process.env.VERCEL_AI_GATEWAY_KEY;
  const savedAi = process.env.AI_GATEWAY_API_KEY;
  beforeEach(() => {
    delete process.env.VERCEL_AI_GATEWAY_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
  });
  afterEach(() => {
    if (savedGateway === undefined) delete process.env.VERCEL_AI_GATEWAY_KEY;
    else process.env.VERCEL_AI_GATEWAY_KEY = savedGateway;
    if (savedAi === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = savedAi;
  });

  test('a loss becomes a general hypothesis and category priors', async () => {
    const paths = tempPaths();
    appendJsonl(paths.liveGames, {
      kind: 'live-game',
      id: 'loss-1',
      ts: Date.now(),
      configId: 'cfg',
      configPath: 'configs/champion.yaml',
      username: 'Us',
      ourSide: 'p1',
      winner: 'loss',
      rating: 990,
      gxe: 48,
      inputLog: '',
      log: '|player|p1|Us|1\n|player|p2|Them|2\n|move|p2a: Tackle|p1a: Foe\n|switch|p2a: Bench|Bench, L80|100/100',
    });
    const reviewed = await runAnalyst(paths, { once: true, ladderDirs: [] });
    expect(reviewed).toBe(1);
    expect(await runAnalyst(paths, { once: true, ladderDirs: [] })).toBe(0);

    const db = openDb(paths);
    const titles = db.getNodesByType('Hypothesis').map(node => node.title);
    db.close();
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.join(' ')).not.toMatch(/Garchomp|Tackle/);
    const priors = JSON.parse(fs.readFileSync(paths.priors, 'utf8'));
    expect(priors.physical).toBeGreaterThan(0);
    expect(priors).not.toHaveProperty('tackle');
  });
});

describe('local ladder dry run', () => {
  test('an approved config plays one game on the local server and records rating', async () => {
    const paths = tempPaths();
    const verdict = judge(paths, {
      configPath: 'configs/champion.yaml',
      action: 'champion',
      wins: 250,
      losses: 100,
      invalid: 0,
      crashes: 0,
      diagnostics: { passed: 1, failed: 0, total: 1 },
    });
    expect(verdict.labeled).toBe(true);
    fs.writeFileSync(paths.variants, JSON.stringify({ variants: [{ id: 'switch-depth2' }, { id: 'llm-blocks' }] }));
    const server = await startLocalServer(0);
    try {
      const summary = await runLive({
        paths,
        local: true,
        server: server.url,
        games: 1,
        runners: 1,
        concurrency: 1,
        username: 'localbot',
        once: true,
        timeoutMs: 90_000,
      });
      expect(summary.games).toBe(1);
      expect(summary.rating).not.toBeUndefined();
      const games = readJsonl<{
        schema: string;
        source: string;
        kind: string;
        gxe: number | null;
        eloAfter: number | null;
        endReason: string;
        latencyP50Ms: number | null;
        minTimerMarginSec: number | null;
        configId: string;
        variantId?: string;
        opponent: string | null;
      }>(paths.liveGames);
      expect(games).toHaveLength(1);
      expect(games[0]).toMatchObject({
        schema: 'jev.ladder-game.v1',
        source: 'ops',
        kind: 'ladder-game',
      });
      expect(games[0].gxe).toEqual(expect.any(Number));
      expect(games[0].eloAfter).toEqual(expect.any(Number));
      expect(games[0].endReason).toEqual(expect.any(String));
      expect(games[0]).toHaveProperty('latencyP50Ms');
      expect(games[0]).toHaveProperty('minTimerMarginSec');
      expect(games[0].gxe).not.toBe(50);
      expect(['switch-depth2', 'llm-blocks']).toContain(games[0].variantId);
      const screen = statusReport(paths);
      expect(screen).toContain('rating');
      expect(screen).toContain('queue');
      expect(screen).toContain('open regressions');
      expect(dailyReport(paths)).toContain('not a ladder rating');
    } finally {
      await server.close();
    }
  }, 120_000);
});

describe('live slots', () => {
  test('concurrency and runners use the shared limit', () => {
    expect(liveSlotLimit({})).toBe(1);
    expect(liveSlotLimit({ concurrency: 3, runners: 2 })).toBe(6);
    expect(liveSlotLimit({ concurrency: 99 })).toBe(16);
    expect(liveSlotLimit({ runners: 4 })).toBe(4);
  });
});

describe('factory', () => {
  test('replays one position and does not grant a label', async () => {
    const paths = tempPaths();
    enqueue(paths, { kind: 'position-replay', labelDepth: 1 });
    const ran = await runFactory(paths, { once: true });
    expect(ran).toBe(1);
    expect(labelsOf(paths)).toHaveLength(0);
    const db = openDb(paths);
    const result = db.getNodesByType('Result')[0];
    db.close();
    expect(result?.description).toContain('disagrees');
    expect(await runFactory(paths, { once: true })).toBe(0);
  }, 60_000);
});

function scriptedGame(
  index: number,
  winner: 'p1' | 'p2',
  p1ConfigId: string,
  p2ConfigId: string,
  extra: { p2Invalid?: number; crashed?: boolean } = {},
): GameResult {
  return {
    index,
    seed: index,
    winner,
    turns: 1,
    p1Invalid: 0,
    p2Invalid: extra.p2Invalid ?? 0,
    crashed: Boolean(extra.crashed),
    p1TurnTimes: [],
    p2TurnTimes: [],
    p1ConfigId,
    p2ConfigId,
    p1Decisions: 0,
    p1Switches: 0,
    p1Predicted: 0,
    p1Answered: 0,
    p2Decisions: 0,
    p2Switches: 0,
    p2Predicted: 0,
    p2Answered: 0,
  } as unknown as GameResult;
}

function labelsOf(paths: ReturnType<typeof tempPaths>) {
  const db = openDb(paths);
  try {
    return readLabels(db);
  } finally {
    db.close();
  }
}

test('category counts ignore species names', () => {
  const counts = emptyCounts();
  observeLog('|move|p2a: Surf|p1a: Foe\n|move|p1a: Tackle|p2a: Foe', counts, 'p2');
  const priors = countsToPriors(counts);
  expect(priors.special).toBeGreaterThan(0);
  expect(priors.physical).toBe(0);
});
