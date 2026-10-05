import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WebSocketServer } from 'ws';
import {
  allocate,
  effectiveState,
  nextCircuit,
  noteOutcome,
  parseCircuitBook,
  releaseChampionPulls,
  selectionPool,
  streakLimit,
  type CircuitState,
} from './allocate.js';
import { countsFromLiveGames, loadVariantPool, thompsonDraw } from './variants.js';
import { runAnalyst } from './analyst.js';
import { openDb } from './db.js';
import { runFactory } from './factory.js';
import { bootstrapChampion, diagnosticsForConfig, exactDiagnosticsConfig, ingestRecordedEvidence, judge, reviewHandoffs, reviewProposals, sprt } from './gatekeeper.js';
import type { GameResult } from '../bench/game.js';
import { loadConfig } from '../config/load.js';
import { liveProposalAllowed, tallySide } from './sprt.js';
import { queueHypothesisVariant } from './hypotheses.js';
import { completeJob, claimNext, enqueue, listJobs, listProposals } from './queue.js';
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
    expect(allocate([{ ...champion, pulled: true }], () => 0.1)?.configId).toBe('champ');
  });

  test('a champion with a 20% baseline stays playable after five losses and live keeps scheduling', async () => {
    const limits = { maxLosses: 5, maxDrop: 40, window: 10, baselineWinRate: 0.2, role: 'champion' as const };
    let state: CircuitState | undefined;
    for (let index = 0; index < 5; index++) state = nextCircuit(state, 'loss', 1000, limits);
    expect(state?.pulled).toBe(false);
    expect(state?.regression).toBeFalsy();
    expect(state?.consecutiveLosses).toBe(5);
    expect(streakLimit(0.2)).toBe(14);

    let notable: CircuitState | undefined;
    for (let index = 0; index < 5; index++) {
      notable = nextCircuit(notable, 'loss', 1500, { maxDrop: 40, window: 10, baselineWinRate: 0.5, role: 'champion' });
    }
    expect(notable?.pulled).toBe(false);
    expect(notable?.regression).toBe(true);
    const active = { configId: 'new', configPath: 'configs/champion.yaml', labels: ['champion', 'live-approved'] };
    const prior = { configId: 'old', configPath: 'configs/old.yaml', labels: ['champion', 'live-approved'] };
    expect(selectionPool([active], { new: notable! }, [prior], Date.now())[0]?.configId).toBe('old');
    const stuck = selectionPool([active], { new: notable! }, [], Date.now());
    expect(stuck[0]?.configId).toBe('new');
    expect(allocate(stuck, () => 0)).not.toBeNull();
    expect(allocate([{ ...active, pulled: true }], () => 0)).not.toBeNull();

    const paths = tempPaths();
    judge(paths, {
      configPath: 'configs/champion.yaml',
      action: 'champion',
      wins: 250,
      losses: 100,
      invalid: 0,
      crashes: 0,
      diagnostics: { passed: 1, failed: 0, total: 1 },
    });
    const labeled = labelsOf(paths)[0];
    const seeded = {
      consecutiveLosses: 5,
      ratings: [] as number[],
      pulled: true,
      reason: '5 consecutive losses',
    };
    fs.writeFileSync(paths.circuits, JSON.stringify({ [labeled.configId]: seeded }));
    const book = parseCircuitBook(JSON.parse(fs.readFileSync(paths.circuits, 'utf8')));
    expect(book.local[labeled.configId]).toBeUndefined();
    const ladder = { ...book.ladder };
    expect(releaseChampionPulls(ladder, [{ ...labeled, labels: labeled.labels }])).toBe(true);
    expect(ladder[labeled.configId]?.pulled).toBe(false);
    expect(selectionPool(
      [{ configId: labeled.configId, configPath: labeled.configPath, labels: labeled.labels }],
      book.ladder,
      [],
      Date.now(),
    ).some(config => config.pulled)).toBe(false);

    const server = await rejectingServer();
    try {
      const summary = await runLive({
        paths,
        local: true,
        server: server.url,
        username: 'localbot',
        timeoutMs: 800,
      });
      expect(summary.skipped).toBe('window');
      expect(summary.skipped).not.toBe('every approved config is pulled');
      expect(server.searches()).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  }, 20_000);

  test('a challenger pull follows the baseline win rate and cools down, and local losses stay off the ladder breaker', () => {
    const limits = {
      maxDrop: 40,
      window: 10,
      baselineWinRate: 0.2,
      role: 'challenger' as const,
      now: 1_000,
      cooldownMs: 50,
    };
    let state: CircuitState | undefined;
    for (let index = 0; index < 5; index++) state = nextCircuit(state, 'loss', null, limits);
    expect(state?.pulled).toBe(false);
    for (let index = 0; index < 9; index++) state = nextCircuit(state, 'loss', null, limits);
    expect(state?.consecutiveLosses).toBe(14);
    expect(state?.pulled).toBe(true);
    expect(state?.cooldownUntil).toBe(1_050);
    const cooled = effectiveState(state, 1_050);
    expect(cooled?.pulled).toBe(false);
    expect(cooled?.consecutiveLosses).toBe(0);
    const resumed = nextCircuit(state, 'loss', null, { ...limits, now: 1_050 });
    expect(resumed.pulled).toBe(false);
    expect(resumed.consecutiveLosses).toBe(1);

    let book = parseCircuitBook({
      champ: { consecutiveLosses: 2, ratings: [1400, 1390], pulled: false },
    });
    for (let index = 0; index < 5; index++) {
      book = noteOutcome(book, 'local', 'champ', 'loss', 900, {
        maxDrop: 40,
        window: 10,
        baselineWinRate: 0.2,
        role: 'champion',
      });
    }
    expect(book.ladder.champ).toEqual({ consecutiveLosses: 2, ratings: [1400, 1390], pulled: false });
    expect(book.local.champ?.consecutiveLosses).toBe(5);
    expect(book.local.champ?.ratings).toEqual([]);
    expect(book.local.champ?.pulled).toBe(false);

    const dropped = nextCircuit(
      { consecutiveLosses: 0, ratings: [1600], pulled: false },
      'loss',
      1500,
      { maxDrop: 40, window: 5, role: 'champion', baselineWinRate: 0.5 },
    );
    expect(dropped.pulled).toBe(false);
    expect(dropped.regression).toBe(true);
    expect(dropped.reason).toContain('rating drop');
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

describe('recorded screens', () => {
  const screen = {
    policyId: 'EXACT_1PLY_QW',
    searchId: 'exact-1ply-qw',
    configPath: 'configs/exact-1ply-qw.yaml',
    action: 'live-approved' as const,
    opponent: 'EXACT_1PLY',
    information: 'hidden',
    seed: 1,
    samples: 8,
    games: 200,
    wins: 115,
    losses: 85,
    ties: 0,
    invalid: 0,
    crashes: 0,
    viewMiss: 0,
    p99ms: 175,
    maxMs: 510,
    wilson95: [0.506, 0.641] as [number, number],
  };

  function writeScreen(dir: string, patch: Partial<typeof screen> = {}): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'exact-1ply-qw.json'), JSON.stringify({ ...screen, ...patch }));
  }

  test('a 115-85 screen is live-approved once and is not replayed', () => {
    const paths = tempPaths();
    const dir = path.join(paths.root, 'recorded');
    writeScreen(dir);
    const loaded = loadConfig(path.join(process.cwd(), 'configs/exact-1ply-qw.yaml'));
    expect(loaded.config.search.id).toBe('exact-1ply-qw');
    expect(exactDiagnosticsConfig(loaded)?.tera).toBe(true);
    expect(exactDiagnosticsConfig(loadConfig(path.join(process.cwd(), 'configs/champion.yaml')))?.tera).toBeUndefined();
    let calls = 0;
    const first = ingestRecordedEvidence(paths, {
      dir,
      diagnostics: () => {
        calls += 1;
        return { passed: 22, failed: 0, total: 22 };
      },
    });
    expect(first[0].labeled).toBe(true);
    expect(first[0].sprt).toBe('continue');
    expect(calls).toBe(1);
    const labels = labelsOf(paths);
    expect(labels.some(item => item.configId === loaded.configId && item.labels.includes('live-approved') && !item.labels.includes('champion'))).toBe(true);
    expect(listProposals(paths)).toHaveLength(0);
    const db = openDb(paths);
    const result = db.getNodesByType('Result')[0];
    db.close();
    expect(result?.type).toBe('Result');
    expect(result?.metrics).toMatchObject({ wins: 115, losses: 85, games: 200, invalid: 0, p99ms: 175 });
    if (result?.type === 'Result') expect(result.confidence_interval).toEqual([0.506, 0.641]);

    const second = ingestRecordedEvidence(paths, {
      dir,
      diagnostics: () => {
        calls += 1;
        return { passed: 22, failed: 0, total: 22 };
      },
    });
    expect(second[0].labeled).toBe(true);
    expect(calls).toBe(1);
  });

  test('invalid moves in a recorded screen stay unlabeled', () => {
    const paths = tempPaths();
    const dir = path.join(paths.root, 'recorded');
    writeScreen(dir, { invalid: 1 });
    const verdict = ingestRecordedEvidence(paths, {
      dir,
      diagnostics: () => ({ passed: 22, failed: 0, total: 22 }),
    });
    expect(verdict[0].labeled).toBe(false);
    expect(verdict[0].sprt).toBe('continue');
    expect(labelsOf(paths)).toHaveLength(0);
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

  test('SPRT continue plays the next seeds until the budget and the gatekeeper records the handoff', async () => {
    const paths = tempPaths();
    enqueue(paths, {
      kind: 'challenger',
      challenger: 'configs/panel/random.yaml',
      opponent: 'configs/panel/maxdamage.yaml',
      games: 4,
      variantId: 'budget',
    });
    const seeds: number[] = [];
    const play = async (a: { configId: string }, b: { configId: string }, games: number, seed: number) => {
      seeds.push(seed);
      return Array.from({ length: games }, (_, index) => scriptedGame(
        index,
        index % 2 === 0 ? 'p1' : 'p2',
        a.configId,
        b.configId,
      ));
    };
    expect(await runFactory(paths, { once: true, maxGames: 8, play })).toBe(1);
    expect(listJobs(paths)[0].status).toBe('open');
    expect(seeds).toEqual([1000]);
    expect(await runFactory(paths, { once: true, maxGames: 8, play })).toBe(1);
    expect(seeds).toEqual([1000, 1002]);
    const job = listJobs(paths)[0];
    expect(job.status).toBe('done');
    expect(job.handoff).toMatchObject({ sprt: 'continue', games: 8, opponent: 'max-damage' });
    expect(job.proposal).toBeUndefined();
    const verdicts = reviewHandoffs(paths, { diagnostics: () => ({ passed: 1, failed: 0, total: 1 }) });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].labeled).toBe(false);
    expect(labelsOf(paths)).toHaveLength(0);
    const db = openDb(paths);
    try {
      expect(db.getNodesByType('Decision').length).toBe(1);
    } finally {
      db.close();
    }
  });

  test('a series SPRT would promote is proposed and not labeled against max-damage', async () => {
    const paths = tempPaths();
    enqueue(paths, {
      kind: 'challenger',
      challenger: 'configs/panel/random.yaml',
      opponent: 'configs/panel/maxdamage.yaml',
      games: 120,
      variantId: 'promote-vs-damage',
    });
    const play = async (a: { configId: string }, b: { configId: string }, games: number) => (
      Array.from({ length: games }, (_, index) => scriptedGame(index, 'p1', a.configId, b.configId))
    );
    expect(await runFactory(paths, { once: true, maxGames: 200, play })).toBe(1);
    const job = listJobs(paths)[0];
    expect(job.status).toBe('done');
    expect(job.proposal?.action).toBe('live-approved');
    expect(job.handoff).toBeUndefined();
    expect(listProposals(paths)).toHaveLength(1);
    expect(labelsOf(paths)).toHaveLength(0);
  });

  test('a series SPRT rejects is handed to the gatekeeper and not labeled', async () => {
    const paths = tempPaths();
    enqueue(paths, {
      kind: 'challenger',
      challenger: 'configs/panel/random.yaml',
      opponent: 'configs/panel/maxdamage.yaml',
      games: 120,
      variantId: 'reject-vs-damage',
    });
    const play = async (a: { configId: string }, b: { configId: string }, games: number) => (
      Array.from({ length: games }, (_, index) => scriptedGame(index, 'p2', a.configId, b.configId))
    );
    expect(await runFactory(paths, { once: true, maxGames: 200, play })).toBe(1);
    const verdicts = reviewHandoffs(paths, { diagnostics: () => ({ passed: 1, failed: 0, total: 1 }) });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].labeled).toBe(false);
    expect(verdicts[0].reason).toContain('max-damage');
    expect(labelsOf(paths)).toHaveLength(0);
  });

  test('two variants reach the factory as different configs and the champion file stays hp-fraction', async () => {
    const paths = tempPaths();
    const db = openDb(paths);
    const now = Date.now();
    for (const node of [
      { id: 'h-pres', title: 'eval-term: preservation', description: 'preservation' },
      { id: 'h-switch', title: 'mechanism: switch-timing', description: 'switch timing' },
    ]) {
      db.addNode({
        id: node.id,
        type: 'Hypothesis',
        status: 'open',
        title: node.title,
        description: node.description,
        created_at: now,
        updated_at: now,
        rationale: node.description,
        expected_effect: 'Paired win rate against max-damage.',
        test_plan: 'Self-play the mapped term. Do not add a species rule.',
      });
    }
    queueHypothesisVariant(paths, db, { id: 'h-pres', title: 'eval-term: preservation', description: 'preservation' });
    queueHypothesisVariant(paths, db, { id: 'h-switch', title: 'mechanism: switch-timing', description: 'switch timing' });
    db.close();
    const seen: string[] = [];
    const play = async (a: { configId: string }, b: { configId: string }, games: number) => {
      seen.push(a.configId);
      return Array.from({ length: games }, (_, index) => scriptedGame(index, 'p2', a.configId, b.configId));
    };
    await runFactory(paths, { once: true, maxGames: 2, play });
    await runFactory(paths, { once: true, maxGames: 2, play });
    expect(new Set(seen).size).toBe(2);
    const champion = loadConfig('configs/champion.yaml');
    expect(champion.config.evaluator.id).toBe('hp-fraction');
    const preservation = loadConfig(path.join(paths.root, 'challengers', 'preservation.yaml'));
    expect(preservation.config.evaluator.params.weights.preservation).toBe(1.5);
    expect(preservation.config.evaluator.params.weights.hpDifference).toBe(1);
    expect(preservation.configId).not.toBe(champion.configId);
  });
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

async function rejectingServer() {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>(resolve => wss.once('listening', () => resolve()));
  const address = wss.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  let searches = 0;
  wss.on('connection', socket => {
    socket.send('|challstr|local\n');
    socket.on('message', data => {
      const text = data.toString();
      const trn = text.match(/\/trn ([^,|]+)/);
      if (trn) socket.send(`|updateuser| ${trn[1].trim()}|1|1\n`);
      if (text.includes('/search')) {
        searches += 1;
        socket.send('|popup|Due to high load, you are limited to 5 games at the same time.\n');
      }
    });
  });
  return {
    searches: () => searches,
    url: `ws://127.0.0.1:${address.port}/showdown/websocket`,
    close: () => new Promise<void>(resolve => wss.close(() => resolve())),
  };
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
