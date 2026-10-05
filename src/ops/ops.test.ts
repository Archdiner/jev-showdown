import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { allocate, nextCircuit } from './allocate.js';
import { countsFromLiveGames, loadVariantPool, thompsonDraw } from './variants.js';
import { runAnalyst } from './analyst.js';
import { openDb } from './db.js';
import { runFactory } from './factory.js';
import { bootstrapChampion, judge, sprt } from './gatekeeper.js';
import { readLabels } from './labels-read.js';
import { startLocalServer } from './local-server.js';
import { liveSlotLimit, runLive } from './live.js';
import { appendJsonl, opsPaths, readJsonl } from './paths.js';
import { observeLog, emptyCounts, countsToPriors } from './priors.js';
import { claimNext, completeJob, enqueue, listJobs } from './queue.js';
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

  test('bootstrap labels the current champion only when diagnostics are 100%', () => {
    const paths = tempPaths();
    const verdict = bootstrapChampion(paths);
    const match = verdict.reason.match(/diagnostics (\d+)\/(\d+)/);
    expect(match).not.toBeNull();
    const passed = Number(match?.[1]);
    const total = Number(match?.[2]);
    expect(verdict.labeled).toBe(passed === total && total > 0);
  });
});

describe('analyst', () => {
  test('a loss becomes a general hypothesis and category priors', async () => {
    const paths = tempPaths();
    appendJsonl(paths.liveGames, {
      kind: 'live-game',
      id: 'loss-1',
      ts: Date.now(),
      configId: 'cfg',
      configPath: 'configs/champion.yaml',
      winner: 'loss',
      rating: 990,
      gxe: 48,
      inputLog: '',
      log: '|move|p2a: Tackle|p1a: Foe\n|switch|p2a: Bench|Bench, L80|100/100',
    });
    const reviewed = await runAnalyst(paths, { once: true });
    expect(reviewed).toBe(1);
    expect(await runAnalyst(paths, { once: true })).toBe(0);

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
      const games = readJsonl<{ rating: number; gxe: number; configId: string; variantId?: string }>(paths.liveGames);
      expect(games).toHaveLength(1);
      expect(games[0].gxe).toEqual(expect.any(Number));
      expect(['switch-depth2', 'llm-blocks']).toContain(games[0].variantId);
      const screen = statusReport(paths);
      expect(screen).toContain('rating');
      expect(screen).toContain('queue');
      expect(screen).toContain('open regressions');
      expect(dailyReport(paths)).toContain('Rating moved');
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
  observeLog('|move|p2a: Surf|p1a: Foe\n|move|p1a: Tackle|p2a: Foe', counts);
  const priors = countsToPriors(counts);
  expect(priors.special).toBeGreaterThan(0);
  expect(priors.physical).toBe(0);
});
