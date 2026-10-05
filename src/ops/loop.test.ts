import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from '../config/load.js';
import { generalizeFinding } from '../exp/analyst.js';
import { writeFindingAsHypothesis } from '../llm/loss-reviewer.js';
import { runAnalyst } from './analyst.js';
import { degenerateAlert, DEGENERATE_STREAK, foldCycle, stallAlert, STALL_MS } from './cycle.js';
import { openDb } from './db.js';
import { enqueueOpenHypotheses, variantFor } from './hypotheses.js';
import { opsPaths } from './paths.js';
import { completeJob, listJobs } from './queue.js';
import { CHECKS } from './sentinel/checks.js';
import { loadContext } from './sentinel/load.js';
import { scanOnce } from './sentinel/run.js';
import { statusReport } from './status.js';
import type { GitStatus, Layout } from './sentinel/types.js';

function tempPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-loop-'));
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

function ladderLoss(dir: string, id: string): void {
  const replayDir = path.join(dir, 'replays');
  fs.mkdirSync(replayDir, { recursive: true });
  const replay = path.join(replayDir, `${id}.log`);
  fs.writeFileSync(replay, [
    '|player|p1|archinder|1',
    '|player|p2|Foe|2',
    '|move|p2a: Tackle|p1a: Us',
    '|win|Foe',
  ].join('\n'));
  const result = {
    ts: 3,
    type: 'result',
    schema: 'jev.ladder-game.v1',
    kind: 'ladder-game',
    id,
    battleId: id,
    username: 'archinder',
    ourSide: 'p1',
    outcome: 'loss',
    winner: 'Foe',
    configId: 'champion-exact-1ply',
    engine: 'search',
    localReplayPath: replay,
  };
  const file = path.join(dir, `archinder-battle-${id}.jsonl`);
  fs.appendFileSync(file, `${JSON.stringify({ ts: 1, type: 'game_start', battleId: id, username: 'archinder' })}\n`);
  fs.appendFileSync(file, `${JSON.stringify({ ts: 2, type: 'turn', battleId: id, turn: 3, choice: 'move 1' })}\n`);
  fs.appendFileSync(file, `${JSON.stringify(result)}\n`);
}

describe('live loss reaches the factory', () => {
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

  test('a ladder battle log with a loss and no >start input queues a job', async () => {
    const paths = tempPaths();
    const ladder = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-archinder-'));
    ladderLoss(ladder, 'gen9randombattle-42');

    const reviewed = await runAnalyst(paths, { once: true, ladderDirs: [ladder] });
    expect(reviewed).toBe(1);

    const jobs = listJobs(paths).filter(job => job.status === 'open' || job.status === 'in_progress');
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.some(job => job.spec.kind === 'challenger' && job.spec.variantId === 'hpDifference')).toBe(true);
    const queued = jobs.find(job => job.spec.variantId === 'hpDifference');
    const loaded = loadConfig(queued!.spec.challenger!);
    expect(loaded.config.evaluator.id).toBe('weighted');
    expect(loaded.config.evaluator.params.weights.hpDifference).toBe(1.5);
    expect(loaded.configId).not.toBe(loadConfig('configs/champion.yaml').configId);

    const screen = statusReport(paths);
    expect(screen).toContain('cycle losses 1  hypotheses 1  queued 1');
    expect(screen).toContain('last pass losses 1  hypotheses 1  queued 1  skipped 0');
    expect(screen).toContain('alert none');
    const lines = fs.readFileSync(paths.dispositions, 'utf8').trim().split('\n');
    const disposition = JSON.parse(lines[0]) as { action: string; reason: string };
    expect(disposition.action).toBe('queued');
    expect(disposition.reason).toContain('no >start input');
  });

  test('a second loss of the same variant is skipped in the log and does not add a job', async () => {
    const paths = tempPaths();
    const ladder = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-archinder-'));
    ladderLoss(ladder, 'gen9randombattle-7');
    ladderLoss(ladder, 'gen9randombattle-8');
    await runAnalyst(paths, { once: true, ladderDirs: [ladder] });

    const jobs = listJobs(paths);
    expect(jobs).toHaveLength(1);
    const rows = fs.readFileSync(paths.dispositions, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { action: string; reason: string });
    expect(rows.map(row => row.action)).toEqual(['queued', 'skipped']);
    expect(rows[1].reason).toContain('already queued');
    expect(statusReport(paths)).toContain('cycle losses 2  hypotheses 2  queued 1');
    expect(statusReport(paths)).toContain('skipped 1');
  });

  test('a finished SPRT-continue job is resumed instead of left queued', async () => {
    const paths = tempPaths();
    const ladder = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-archinder-'));
    ladderLoss(ladder, 'gen9randombattle-7');
    await runAnalyst(paths, { once: true, ladderDirs: [ladder] });
    const first = listJobs(paths)[0];
    completeJob(paths, first.id, {
      status: 'done',
      resultId: `result-${first.idempotencyKey}`,
      progress: { wins: 1, losses: 3, games: 4, invalid: 0, crashes: 0, sprt: 'continue', seed: 1002 },
    });

    ladderLoss(ladder, 'gen9randombattle-8');
    await runAnalyst(paths, { once: true, ladderDirs: [ladder] });
    const jobs = listJobs(paths);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('open');
    expect(jobs[0].progress?.seed).toBe(1002);
    const rows = fs.readFileSync(paths.dispositions, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { reason: string });
    expect(rows[rows.length - 1].reason).toContain('resumed');
    expect(rows[rows.length - 1].reason).not.toContain('already queued');
  });
});

describe('factory reads hypotheses', () => {
  test('an open hypothesis node becomes one challenger job', () => {
    const paths = tempPaths();
    const db = openDb(paths);
    writeFindingAsHypothesis(db, generalizeFinding({
      criticalTurn: 2,
      mistakeClass: 'tera-timing',
      summary: 'Tera was spent early.',
      hypothesis: {
        title: 'hold tera',
        rationale: 'Tera timing is a general mechanism.',
        expectedEffect: 'Later tera use raises paired win rate.',
        testPlan: 'Sweep the mechanism on paired games.',
        killCondition: 'No win-rate gain.',
      },
    }), { model: 'local-fallback', battleId: 'battle-db' });
    const queued = enqueueOpenHypotheses(paths, db);
    db.close();
    expect(queued).toBe(1);
    const jobs = listJobs(paths);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].spec).toMatchObject({ kind: 'challenger', variantId: 'tera-timing', opponent: expect.stringContaining('maxdamage.yaml') });
    expect(loadConfig(jobs[0].spec.challenger!).config.policies.teraPolicy.id).toBe('heuristic');
    const again = openDb(paths);
    try {
      expect(enqueueOpenHypotheses(paths, again)).toBe(0);
    } finally {
      again.close();
    }
  });

  test('a hypotheses.json row is queued and an unmapped row is skipped', () => {
    const paths = tempPaths();
    fs.writeFileSync(paths.hypotheses, JSON.stringify([
      {
        id: 'H01',
        change: 'Add a Tera-hold prior so tera is not spent early.',
        expected_effect: 'Later median tera turn and a higher win rate.',
        metric: 'Win rate versus the frozen panel.',
      },
      {
        id: 'H15',
        change: 'Limit the strategist to tie-breaking and post-game review.',
        expected_effect: 'Fewer timeouts.',
        metric: 'Call latency.',
      },
    ]));
    const db = openDb(paths);
    const queued = enqueueOpenHypotheses(paths, db);
    db.close();
    expect(queued).toBe(1);
    expect(listJobs(paths).map(job => job.spec.variantId)).toEqual(['tera-timing']);
    const notes = fs.readFileSync(paths.dispositions, 'utf8');
    expect(notes).toContain('queued variant tera-timing');
    expect(notes).toContain('no self-play variant for hypothesis hyp-file-h15');
    expect(variantFor('mechanism: information')).toBeNull();
    expect(variantFor('eval-term: preservation')).toBe('preservation');
    expect(variantFor('Raise the opponent-switch probability in the opponent model')).toBe('prediction');
    expect(variantFor('Bayesian prior; hazard damage rules out Boots')).toBe('prediction');
    expect(variantFor('Add a hazard-context term for setters')).toBe('hazard-control');
    expect(variantFor('Win-condition preservation bonus')).toBe('preservation');
    expect(variantFor('Information-hiding term for an unrevealed mon')).toBeNull();
  });
});

describe('improvement stall', () => {
  test('losses reviewed with nothing queued for 15 min is a P1', () => {
    const events = [{
      ts: 0,
      type: 'loss',
      hypotheses: 1,
      queued: 0,
      reason: 'skipped: variant preservation already queued as ops-job-1',
    }];
    const view = foldCycle(events);
    expect(stallAlert(view, STALL_MS - 1)).toBeNull();
    const alert = stallAlert(view, STALL_MS);
    expect(alert?.level).toBe('P1');
    expect(alert?.message).toContain('losses reviewed 1');
    expect(alert?.message).toContain('nothing queued');
    expect(alert?.message).toContain('15 min');

    const paths = tempPaths();
    fs.writeFileSync(paths.cycle, `${JSON.stringify({ ...events[0], ts: Date.now() - STALL_MS - 1000 })}\n`);
    expect(statusReport(paths)).toContain('alert P1');
    expect(statusReport(paths)).toContain('nothing queued');

    const layout = layoutFor(paths.root);
    const git: GitStatus = { behind: 0, ref: 'origin/main', detail: 'HEAD contains origin/main' };
    fs.writeFileSync(path.join(layout.dataDir, 'gen9-stats.json'), JSON.stringify({ mon: 1 }));
    const result = scanOnce(layout, { now: Date.now(), processes: [], git });
    expect(result.hits.map(hit => hit.id)).toContain('improvement-stall');
    const check = CHECKS.find(item => item.id === 'improvement-stall');
    expect(check?.severity).toBe('P1');
    const quiet = loadContext(layout, { now: Date.now() - STALL_MS * 2, processes: [], git });
    expect(check?.detect(quiet)).toEqual([]);
  });
});

describe('degenerate loop', () => {
  test('three empty passes, one variant, a mining miss, or one result string is a P1', () => {
    const pass = (jobsQueued: number) => ({
      ts: 1,
      type: 'pass',
      lossesReviewed: 1,
      hypothesesCreated: 1,
      jobsQueued,
      skipped: jobsQueued === 0 ? 1 : 0,
    });
    expect(degenerateAlert([pass(0), pass(0)])).toBeNull();
    const queued = degenerateAlert([pass(0), pass(0), pass(0)]);
    expect(queued?.level).toBe('P1');
    expect(queued?.message).toContain('queued 0');
    expect(degenerateAlert([pass(0), pass(0), pass(1)])).toBeNull();

    const mine = { ts: 1, type: 'loss', hypotheses: 1, queued: 0, reason: 'skipped mine: ladder log has no >start input and no |request| to reconstruct' };
    expect(degenerateAlert([mine, mine])).toBeNull();
    expect(degenerateAlert([mine, mine, mine])?.message).toContain('mining failed');

    const same = { ts: 1, type: 'loss', hypotheses: 1, queued: 0, reason: 'skipped: variant preservation already queued as ops-job-1' };
    expect(degenerateAlert([same, same, same])?.message).toContain('preservation');

    const tested = { ts: 1, type: 'tested', summary: '1/4 wins, invalid 0, SPRT continue' };
    expect(degenerateAlert([tested, tested])).toBeNull();
    expect(degenerateAlert([tested, tested, tested])?.message).toContain('1/4 wins, invalid 0, SPRT continue');
    expect(DEGENERATE_STREAK).toBe(3);

    const paths = tempPaths();
    const rows = [pass(0), pass(0), pass(0)].map((row, index) => ({ ...row, ts: Date.now() - 1000 + index }));
    fs.writeFileSync(paths.cycle, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
    expect(statusReport(paths)).toContain('alert P1');
    expect(statusReport(paths)).toContain('queued 0');
  });
});

function layoutFor(root: string): Layout {
  const layout: Layout = {
    cwd: root,
    liveRepoDir: null,
    opsDir: root,
    ladderLogDir: path.join(root, 'ladder'),
    liveRunsDir: path.join(root, 'live-runs'),
    dataDir: path.join(root, 'data'),
    graphDb: path.join(root, 'graph.db'),
  };
  fs.mkdirSync(layout.dataDir, { recursive: true });
  return layout;
}
