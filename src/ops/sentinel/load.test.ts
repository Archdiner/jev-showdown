import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildSnapshot } from '../../dashboard/snapshot.js';
import type { DashboardPaths } from '../../dashboard/paths.js';
import { GraphDB } from '../../graph/db.js';
import type { OpsPaths } from '../paths.js';
import { statusReport } from '../status.js';
import { loadIncidents, incidentStore } from './incidents.js';
import { jsonlBytesRead, LOG_TAIL_CHUNK_BYTES, LOG_TAIL_MAX_BYTES, loadContext, resetJsonlByteCount } from './load.js';
import { runSentinel, scanOnce } from './run.js';
import type { GitStatus, Layout } from './types.js';

const quietGit: GitStatus = { behind: 0, ref: 'origin/main', detail: 'HEAD contains origin/main' };
/** Above the measured spread limit: loadContext throws at 123,121 rows in one file. */
const LINES = 220_000;

function speciesMap(count: number): string {
  const body: Record<string, number> = {};
  for (let index = 0; index < count; index++) body[`mon${index}`] = 1;
  return JSON.stringify(body);
}

function tempLayout(): { root: string; layout: Layout } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-sentinel-load-'));
  const layout: Layout = {
    cwd: root,
    liveRepoDir: null,
    opsDir: path.join(root, 'ops'),
    ladderLogDir: path.join(root, 'ladder'),
    liveRunsDir: path.join(root, 'live-runs'),
    dataDir: path.join(root, 'data'),
    graphDb: path.join(root, 'graph.db'),
  };
  fs.mkdirSync(layout.opsDir, { recursive: true });
  fs.mkdirSync(layout.ladderLogDir, { recursive: true });
  fs.mkdirSync(layout.dataDir, { recursive: true });
  fs.writeFileSync(path.join(layout.dataDir, 'gen9-stats.json'), speciesMap(500));
  return { root, layout };
}

function writeLines(file: string, count: number, line: (index: number) => string): void {
  const fd = fs.openSync(file, 'w');
  try {
    let pending = '';
    for (let index = 0; index < count; index++) {
      pending += `${line(index)}\n`;
      if (pending.length >= 1024 * 1024) {
        fs.writeSync(fd, pending);
        pending = '';
      }
    }
    if (pending) fs.writeSync(fd, pending);
  } finally {
    fs.closeSync(fd);
  }
}

function opsPathsFor(layout: Layout): OpsPaths {
  const db = new GraphDB(layout.graphDb);
  db.close();
  const file = (name: string) => path.join(layout.opsDir, name);
  return {
    root: layout.opsDir,
    graph: layout.graphDb,
    heartbeats: file('heartbeats.jsonl'),
    liveGames: file('live-games.jsonl'),
    circuits: file('circuits.json'),
    analystOffset: file('analyst.offset'),
    analystFiles: file('analyst-files.json'),
    seenGames: file('analyst-seen.json'),
    regressionSuite: file('regression-suite.jsonl'),
    priors: file('behavior.json'),
    pool: file('mined-pool.json'),
    variants: file('variants.json'),
    cycle: file('cycle.jsonl'),
    dispositions: file('dispositions.jsonl'),
    hypotheses: file('hypotheses.json'),
  };
}

function dashboardPaths(root: string, layout: Layout): DashboardPaths {
  return {
    cwd: root,
    host: '127.0.0.1',
    port: 0,
    fixtureMode: false,
    opsDir: layout.opsDir,
    ladderLogDir: layout.ladderLogDir,
    searchLogDir: layout.liveRunsDir,
    graphDb: layout.graphDb,
  };
}

describe('sentinel log window', () => {
  test('a short log keeps file line numbers and drops rows before the lookback', () => {
    const { layout } = tempLayout();
    const now = Date.now();
    const game = (battleId: string, ts: number) => JSON.stringify({
      schema: 'jev.ladder-game.v1',
      kind: 'ladder-game',
      source: 'ladder',
      localServer: false,
      username: 'asad',
      format: 'gen9randombattle',
      outcome: 'win',
      endReason: 'ko',
      turns: 4,
      battleId,
      ts,
    });
    fs.writeFileSync(path.join(layout.ladderLogDir, 'games.jsonl'), [
      game('battle-old', now - 48 * 60 * 60 * 1000),
      game('battle-new', now - 1000),
    ].join('\n') + '\n');
    const ctx = loadContext(layout, { now, processes: [], git: quietGit });
    expect(ctx.games.map(row => row.battleId)).toEqual(['battle-new']);
    expect(ctx.games[0].line).toBe(2);
  });

  test('loadContext and scanOnce finish on a jsonl larger than the spread limit', () => {
    const { layout } = tempLayout();
    const now = Date.now();
    const old = now - 48 * 60 * 60 * 1000;
    const decisions = path.join(layout.opsDir, 'decisions.jsonl');
    writeLines(decisions, LINES, index => JSON.stringify({
      type: 'decision',
      ts: old + (index % 1000),
      ms: 5,
      n: index,
      pad: 'x'.repeat(48),
    }));
    fs.appendFileSync(decisions, JSON.stringify({
      type: 'decision',
      ts: now - 1000,
      ms: 12,
      marker: 'tail-kept',
    }));
    const incidents = path.join(layout.opsDir, 'incidents.jsonl');
    writeLines(incidents, LINES, () => JSON.stringify({
      ts: now - 1000,
      type: 'opened',
      incidentId: 'inc-from-the-log',
      checkId: 'crash-or-fallback',
      marker: 'not-input',
    }));
    fs.writeFileSync(path.join(layout.opsDir, 'incidents.json'), `${JSON.stringify({
      version: 1,
      updatedAt: now,
      soakMs: 600_000,
      incidents: [],
    })}\n`);

    expect(LINES).toBeGreaterThan(200_000);
    expect(fs.statSync(decisions).size).toBeGreaterThan(LOG_TAIL_MAX_BYTES);
    expect(fs.statSync(incidents).size).toBeGreaterThan(LOG_TAIL_MAX_BYTES);

    resetJsonlByteCount();
    const started = Date.now();
    const heapBefore = process.memoryUsage().heapUsed;
    const ctx = loadContext(layout, { now, processes: [], git: quietGit });
    const result = scanOnce(layout, { now, processes: [], git: quietGit });
    const elapsed = Date.now() - started;
    const heapDelta = process.memoryUsage().heapUsed - heapBefore;
    const bytes = jsonlBytesRead();
    expect(ctx.rows.some(row => row.value?.marker === 'tail-kept')).toBe(true);
    expect(ctx.rows.some(row => String(row.file).endsWith(`${path.sep}incidents.jsonl`))).toBe(false);
    expect(ctx.rows.some(row => row.value?.marker === 'not-input')).toBe(false);
    expect(ctx.decisionSamples).toEqual([expect.objectContaining({ ms: 12 })]);
    expect(ctx.rows.length).toBeLessThan(20);
    expect(result.openP0).toBe(0);
    expect(loadIncidents(incidentStore(layout.opsDir)).some(item => item.id === 'inc-from-the-log')).toBe(false);
    // Two scans of the decisions tail. The incident log is not an input.
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(LOG_TAIL_CHUNK_BYTES * 8);
    expect(elapsed).toBeLessThan(2_000);
    expect(heapDelta).toBeLessThan(64 * 1024 * 1024);
  }, 60_000);
});

describe('sentinel crash is visible', () => {
  test('a thrown scan writes an error heartbeat that status and the dashboard show', async () => {
    const { root, layout } = tempLayout();
    fs.mkdirSync(path.join(layout.opsDir, 'incidents.json'));
    const errors: string[] = [];
    const original = console.error;
    console.error = (line?: unknown) => {
      errors.push(String(line));
    };
    try {
      await expect(runSentinel(layout, { once: true, processes: [], git: quietGit })).rejects.toThrow(/EISDIR|ENOTDIR/);
    } finally {
      console.error = original;
    }
    expect(errors.join('\n')).toContain('sentinel crashed:');
    const beats = fs.readFileSync(path.join(layout.opsDir, 'heartbeats.jsonl'), 'utf8');
    const beat = JSON.parse(beats.trim().split('\n').at(-1) ?? '') as { facility: string; status: string; detail: string };
    expect(beat).toMatchObject({ facility: 'sentinel', status: 'error' });
    expect(beat.detail).toMatch(/Error:/);
    expect(beat.detail).not.toContain('\n');

    const paths = opsPathsFor(layout);
    expect(statusReport(paths)).toMatch(/sentinel\s+error/);
    const snapshot = buildSnapshot(dashboardPaths(root, layout));
    expect(snapshot.ops.facilities.find(item => item.name === 'sentinel')).toMatchObject({ health: 'error' });
    expect(snapshot.ops.statusText).toMatch(/sentinel\s+error/);
  });
});
