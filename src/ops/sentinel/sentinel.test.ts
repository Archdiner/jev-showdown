import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphDB } from '../../graph/db.js';
import { CHECKS } from './checks.js';
import { writeTonightFixture } from './fixtures.js';
import { acknowledge, incidentStore, loadIncidents, markFixing } from './incidents.js';
import { buildScorecard, formatScorecard, parseSince } from './scorecard.js';
import { loadContext, scanProcesses } from './load.js';
import { judge } from '../gatekeeper.js';
import { openDb } from '../db.js';
import { opsPaths } from '../paths.js';
import { readLabels } from '../labels-read.js';
import { loadContext, parseProcessTable, snapshotProcesses } from './load.js';
import { readEvents } from './incidents.js';
import { layoutFromEnv, renderScorecard, runSentinel, scanOnce } from './run.js';
import type { GitStatus, Layout, ProcessSnapshot } from './types.js';

const quietGit: GitStatus = { behind: 0, ref: 'origin/main', detail: 'HEAD contains origin/main' };
const behindGit: GitStatus = { behind: 4, ref: 'origin/main', detail: 'HEAD is 4 commits behind origin/main' };

function speciesMap(count: number): string {
  const body: Record<string, number> = {};
  for (let index = 0; index < count; index++) body[`mon${index}`] = 1;
  return JSON.stringify(body);
}

function emptyRoot(): { root: string; layout: Layout } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-sentinel-'));
  const layout: Layout = {
    cwd: root,
    opsDir: path.join(root, 'ops'),
    ladderLogDir: path.join(root, 'ladder'),
    liveRunsDir: path.join(root, 'live-runs'),
    dataDir: path.join(root, 'data'),
    graphDb: path.join(root, 'graph.db'),
  };
  fs.mkdirSync(layout.opsDir, { recursive: true });
  fs.mkdirSync(layout.dataDir, { recursive: true });
  fs.writeFileSync(path.join(layout.dataDir, 'gen9-stats.json'), speciesMap(500));
  return { root, layout };
}

describe('sentinel checks', () => {
  test('the tonight fixture trips every check', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-tonight-'));
    const fixture = writeTonightFixture(root);
    const result = scanOnce(fixture.layout, {
      now: fixture.now,
      processes: fixture.processes,
      git: behindGit,
    });
    const ids = new Set(result.hits.map(hit => hit.id));
    const missing = CHECKS.map(check => check.id).filter(id => !ids.has(id));
    expect(missing).toEqual([]);
    expect(result.openP0).toBeGreaterThan(0);
    const incidents = loadIncidents(incidentStore(fixture.layout.opsDir));
    const duplicate = incidents.find(item => item.checkId === 'duplicate-ladder-runners');
    expect(duplicate?.evidence.some(item => item.line !== undefined)).toBe(true);
    expect(duplicate?.status).toBe('open');
    const again = scanOnce(fixture.layout, { now: fixture.now + 1000, processes: fixture.processes, git: behindGit });
    const recounted = loadIncidents(incidentStore(fixture.layout.opsDir)).find(item => item.id === duplicate?.id);
    expect(recounted?.count).toBe(2);
    expect(again.openP0).toBe(result.openP0);
  });

  test('a quiet tree opens nothing', () => {
    const { layout } = emptyRoot();
    const result = scanOnce(layout, { now: Date.now(), processes: [], git: quietGit });
    expect(result.hits).toEqual([]);
    expect(result.openP0).toBe(0);
  });

  test('two different accounts are not a duplicate login', () => {
    const { layout } = emptyRoot();
    const processes: ProcessSnapshot[] = [
      { pid: 1, cmd: 'node tsx src/cli/ladder.ts --username asad', env: {} },
      { pid: 2, cmd: 'node tsx src/cli/ladder.ts --username rival', env: {} },
    ];
    const result = scanOnce(layout, { now: Date.now(), processes, git: quietGit });
    expect(result.hits.map(hit => hit.id)).not.toContain('duplicate-ladder-runners');
  });

  test('a local-only replay and a young drain do not page', () => {
    const { layout } = emptyRoot();
    const now = Date.now();
    fs.mkdirSync(layout.ladderLogDir, { recursive: true });
    fs.writeFileSync(path.join(layout.ladderLogDir, 'games.jsonl'), `${JSON.stringify({
      schema: 'jev.ladder-game.v1',
      kind: 'ladder-game',
      source: 'ops',
      localServer: true,
      battleId: 'battle-local',
      ts: now - 1000,
      outcome: 'win',
      endReason: 'ko',
      turns: 8,
      username: 'localbot',
      format: 'gen9randombattle',
      replayUrl: null,
      replayStatus: 'local-only',
      minTimerMarginSec: 12,
      eloAfter: 1000,
      invalidChoices: 0,
      crashes: 0,
      fallbacks: 0,
    })}\n`);
    const drain = path.join(layout.cwd, 'state', 'DRAIN');
    fs.mkdirSync(path.dirname(drain), { recursive: true });
    fs.writeFileSync(drain, '');
    const young = (now - 60_000) / 1000;
    fs.utimesSync(drain, young, young);
    const result = scanOnce(layout, { now, processes: [], git: quietGit });
    const ids = result.hits.map(hit => hit.id);
    expect(ids).not.toContain('replay-unconfirmed');
    expect(ids).not.toContain('drain-pending');
    expect(ids).not.toContain('ghost-rooms');
  });

  test('an incident verifies only after the soak, then reopens', () => {
    const { layout } = emptyRoot();
    fs.writeFileSync(path.join(layout.dataDir, 'gen9-stats.json'), speciesMap(1));
    const now = Date.now();
    const opened = scanOnce(layout, { now, processes: [], git: quietGit, soakMs: 1000 });
    expect(opened.openP0).toBe(1);
    const store = incidentStore(layout.opsDir);
    const id = loadIncidents(store)[0].id;
    expect(acknowledge(store, id, now + 10)).toBeNull();
    fs.writeFileSync(path.join(layout.dataDir, 'gen9-stats.json'), speciesMap(500));
    const resolved = scanOnce(layout, { now: now + 500, processes: [], git: quietGit, soakMs: 1000 });
    expect(resolved.openP0).toBe(0);
    expect(loadIncidents(store)[0].status).toBe('resolved');
    scanOnce(layout, { now: now + 500 + 1000, processes: [], git: quietGit, soakMs: 1000 });
    expect(loadIncidents(store)[0].status).toBe('verified');
    fs.writeFileSync(path.join(layout.dataDir, 'gen9-stats.json'), speciesMap(1));
    const reopened = scanOnce(layout, { now: now + 5000, processes: [], git: quietGit, soakMs: 1000 });
    expect(reopened.openP0).toBe(1);
    expect(loadIncidents(store)[0].status).toBe('open');
    expect(loadIncidents(store)[0].firstSeen).toBe(now);
  });

  test('fixing keeps its PR while the check is still failing', () => {
    const { layout } = emptyRoot();
    fs.writeFileSync(path.join(layout.dataDir, 'gen9-stats.json'), speciesMap(1));
    const now = Date.now();
    scanOnce(layout, { now, processes: [], git: quietGit });
    const store = incidentStore(layout.opsDir);
    const id = loadIncidents(store)[0].id;
    expect(markFixing(store, id, 'https://github.com/Archdiner/jev-showdown/pull/1', now + 1)).toBeNull();
    scanOnce(layout, { now: now + 2, processes: [], git: quietGit });
    const incident = loadIncidents(store)[0];
    expect(incident.status).toBe('fixing');
    expect(incident.pr).toContain('/pull/1');
    expect(incident.count).toBe(2);
  });
});

describe('pulled-config invariant', () => {
  test('ops live idle and every approved config pulled are P1 without /proc', () => {
    const missing = path.join(os.tmpdir(), `jev-noproc-${process.pid}`);
    expect(scanProcesses(missing)).toEqual([]);

    const { layout } = emptyRoot();
    const now = Date.now();
    fs.writeFileSync(path.join(layout.opsDir, 'live-summary.jsonl'), `${JSON.stringify({
      ts: now - 1000,
      games: 488,
      rating: 2720,
      gxe: 100,
      skipped: 'every approved config is pulled',
    })}\n`);
    const reported = scanOnce(layout, { now, scanProcesses: false, git: quietGit });
    const skip = reported.hits.find(hit => hit.id === 'circuits-all-pulled');
    expect(skip?.severity).toBe('P1');
    expect(skip?.key).toBe('live-reported');
    expect(skip?.detail).toContain('every approved config is pulled');
    expect(reported.openP1).toBeGreaterThan(0);

    const paths = opsPaths(layout.opsDir);
    layout.graphDb = paths.graph;
    judge(paths, {
      configPath: 'configs/champion.yaml',
      action: 'champion',
      wins: 250,
      losses: 100,
      invalid: 0,
      crashes: 0,
      diagnostics: { passed: 1, failed: 0, total: 1 },
    });
    const db = openDb(paths);
    const id = readLabels(db)[0].configId;
    db.close();
    fs.rmSync(path.join(layout.opsDir, 'live-summary.jsonl'));
    fs.writeFileSync(path.join(layout.opsDir, 'circuits.json'), JSON.stringify({
      [id]: { consecutiveLosses: 5, ratings: [], pulled: true, reason: '5 consecutive losses' },
      other: { consecutiveLosses: 0, ratings: [], pulled: false },
    }));
    const pulled = scanOnce(layout, { now: now + 10, scanProcesses: false, git: quietGit });
    const circuitHit = pulled.hits.find(hit => hit.id === 'circuits-all-pulled');
    expect(circuitHit?.severity).toBe('P1');
    expect(circuitHit?.detail).toContain(id);
    expect(circuitHit?.detail).toContain('every approved config is pulled');

    const openFile = JSON.parse(fs.readFileSync(path.join(layout.opsDir, 'circuits.json'), 'utf8')) as {
      [key: string]: { pulled: boolean };
    };
    openFile[id].pulled = false;
    fs.writeFileSync(path.join(layout.opsDir, 'circuits.json'), JSON.stringify(openFile));
    const quiet = scanOnce(layout, { now: now + 20, scanProcesses: false, git: quietGit });
    expect(quiet.hits.map(hit => hit.id)).not.toContain('circuits-all-pulled');

describe('runner exit without a drain', () => {
  test('a runner that timed out without a drain is a P1', () => {
    const { layout } = emptyRoot();
    const now = Date.now();
    fs.mkdirSync(layout.liveRunsDir, { recursive: true });
    fs.writeFileSync(path.join(layout.liveRunsDir, 'search10.log'), [
      '[ladder] 25/30 win vs foe turns=20 invalid=0 crashes=0 fallbacks=0 elo=1400',
      '[ladder] Timed out after 25/30 games',
      '',
    ].join('\n'));
    const result = scanOnce(layout, { now, processes: [], git: quietGit });
    const hits = result.hits.filter(hit => hit.id === 'runner-exit-undrained');
    expect(hits.map(hit => hit.severity)).toEqual(['P1']);
    expect(hits.map(hit => hit.key)).toEqual(['undrained-exit']);
    expect(hits[0].detail).toContain('Timed out after 25/30 games');
    expect(result.hits.map(hit => hit.id)).not.toContain('runner-down');
  });

  test('a stalled batch end is a P1 and a user drain is not', () => {
    const { layout } = emptyRoot();
    const now = Date.now();
    fs.mkdirSync(layout.ladderLogDir, { recursive: true });
    fs.writeFileSync(path.join(layout.ladderLogDir, 'summary.json'), JSON.stringify({
      games: 25,
      requested: 30,
      endReason: 'stalled',
      drained: true,
      drainReason: 'stall',
    }));
    fs.writeFileSync(path.join(layout.ladderLogDir, 'games.jsonl'), `${JSON.stringify({
      schema: 'jev.ladder-game.v1',
      kind: 'ladder-game',
      source: 'ladder',
      battleId: 'battle-timer',
      ts: now - 1000,
      outcome: 'loss',
      endReason: 'our-timer',
      turns: 4,
      username: 'asad',
      format: 'gen9randombattle',
      minTimerMarginSec: 1,
      invalidChoices: 0,
      crashes: 0,
      fallbacks: 0,
    })}\n${JSON.stringify({
      v: 1,
      type: 'run',
      ts: now - 500,
      games: 25,
      requested: 30,
      endReason: 'stalled',
      drainRequested: true,
    })}\n`);
    const stalled = scanOnce(layout, { now, processes: [], git: quietGit });
    const hits = stalled.hits.filter(hit => hit.id === 'runner-exit-undrained');
    expect(hits.map(hit => hit.key)).toEqual(['batch-stall']);
    expect(hits[0].severity).toBe('P1');
    expect(hits[0].detail).toContain('endReason=stalled');

    fs.writeFileSync(path.join(layout.ladderLogDir, 'summary.json'), JSON.stringify({
      games: 12,
      requested: 30,
      endReason: 'drained',
      drained: true,
      drainReason: 'SIGTERM',
    }));
    fs.writeFileSync(path.join(layout.ladderLogDir, 'games.jsonl'), `${JSON.stringify({
      v: 1,
      type: 'run',
      ts: now - 500,
      games: 12,
      requested: 30,
      endReason: 'drained',
      drainRequested: true,
    })}\n`);
    const drained = scanOnce(layout, { now, processes: [], git: quietGit });
    expect(drained.hits.map(hit => hit.id)).not.toContain('runner-exit-undrained');

    fs.writeFileSync(path.join(layout.ladderLogDir, 'summary.json'), JSON.stringify({
      games: 30,
      requested: 30,
      endReason: 'completed',
      drained: false,
      drainReason: null,
    }));
    const completed = scanOnce(layout, { now, processes: [], git: quietGit });
    expect(completed.hits.map(hit => hit.id)).not.toContain('runner-exit-undrained');
  });

  test('a missing /proc lists ladder processes from ps and a failed listing does not scan', () => {
    const table = [
      '  10 /usr/bin/sshd',
      '  42 node /Users/me/jev/src/cli/ladder.ts --games 30 --engine search',
      '  43 node /Users/me/jev/src/ops/cli.ts analyst',
      '  44 bash ./run-live.sh --games 30',
    ].join('\n');
    expect(parseProcessTable(table).map(proc => proc.pid)).toEqual([42, 43, 44]);
    const missing = path.join(os.tmpdir(), `jev-noproc-${process.pid}`);
    const listed = snapshotProcesses({ procRoot: missing, readTable: () => table });
    expect(listed.scanned).toBe(true);
    expect(listed.processes.map(proc => proc.pid)).toEqual([42, 43, 44]);
    expect(listed.processes[0].cmd).toContain('src/cli/ladder.ts');
    const failed = snapshotProcesses({
      procRoot: missing,
      readTable: () => {
        throw new Error('ps failed');
      },
    });
    expect(failed).toEqual({ processes: [], scanned: false });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-proc-'));
    const pidDir = path.join(root, '77');
    fs.mkdirSync(pidDir);
    fs.writeFileSync(path.join(pidDir, 'cmdline'), 'node\0src/cli/ladder.ts\0--username\0asad\0');
    fs.writeFileSync(path.join(pidDir, 'environ'), 'SHOWDOWN_USERNAME=asad\0');
    const fromProc = snapshotProcesses({ procRoot: root });
    expect(fromProc.scanned).toBe(true);
    expect(fromProc.processes).toEqual([{
      pid: 77,
      cmd: 'node src/cli/ladder.ts --username asad',
      env: { SHOWDOWN_USERNAME: 'asad' },
    }]);
  });
});

describe('scorecard', () => {
  test('excludes phantoms and names sources', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-score-'));
    const fixture = writeTonightFixture(root);
    scanOnce(fixture.layout, { now: fixture.now, processes: fixture.processes, git: behindGit });
    const db = new GraphDB(fixture.layout.graphDb);
    db.addNode({
      id: 'decision-promote',
      type: 'Decision',
      status: 'done',
      title: 'champion',
      description: 'SPRT no-regression and diagnostics 22/22',
      created_at: fixture.now - 1000,
      updated_at: fixture.now - 1000,
      context: 'champion configs/champion.yaml',
      decision: 'champion',
      consequences: 'labeled',
      metadata: { opsKind: 'gate' },
    });
    db.addNode({
      id: 'decision-reject',
      type: 'Decision',
      status: 'rejected',
      title: 'rejected',
      description: 'SPRT says the challenger is worse than even',
      created_at: fixture.now - 900,
      updated_at: fixture.now - 900,
      context: 'live-approved configs/challenger.yaml',
      decision: 'rejected',
      consequences: 'SPRT says the challenger is worse than even',
      metadata: { opsKind: 'gate' },
    });
    db.addNode({
      id: 'ops-job-1',
      type: 'Experiment',
      status: 'done',
      title: 'ops challenger',
      description: 'finished a paired batch',
      created_at: fixture.now - 2000,
      updated_at: fixture.now - 500,
      metadata: { ops: { spec: { kind: 'challenger' } } },
    });
    db.addNode({
      id: 'regression-1',
      type: 'Learning',
      status: 'detected',
      title: 'Open regression',
      description: 'the challenger lost the panel',
      created_at: fixture.now - 900,
      updated_at: fixture.now - 900,
      insight: 'SPRT says the challenger is worse than even',
      evidence: 'configs/challenger.yaml',
      confidence: 'medium',
      metadata: { opsKind: 'regression' },
    });
    db.close();

    const ctx = loadContext(fixture.layout, { now: fixture.now, processes: fixture.processes, git: behindGit });
    const store = incidentStore(fixture.layout.opsDir);
    const card = buildScorecard(ctx, loadIncidents(store), readEvents(store.eventsPath), 24 * 60 * 60 * 1000);
    expect(card.phantomsExcluded).toBe(fixture.phantoms);
    expect(card.localExcluded).toBe(fixture.localGames);
    expect(card.progress.counted).toBe(fixture.countedGames);
    expect(card.progress.wins).toBe(fixture.wins);
    expect(card.progress.losses).toBe(fixture.losses);
    expect(card.progress.eloFirst).toBe(fixture.eloFirst);
    expect(card.progress.eloLast).toBe(fixture.eloLast);
    expect(card.progress.loopCycles).toBe(3);
    expect(card.progress.promoted.join(' ')).toContain('SPRT no-regression');
    expect(card.progress.rejected.join(' ')).toContain('worse than even');
    expect(card.progress.regressions.join(' ')).toContain('worse than even');
    expect(card.reliability.openP0).toBeGreaterThan(0);
    const text = formatScorecard(card);
    expect(text).toContain('Phantoms excluded: 1');
    expect(text).toContain('games.jsonl');
    expect(text).toContain('heartbeats.jsonl');
    expect(text).toContain('1-13-0 on 14 games');
    expect(text).not.toContain('eloAfter 999');
    expect(text).toContain('7.1%');
    const markdown = formatScorecard(card, 'md');
    expect(markdown.startsWith('# jev scorecard')).toBe(true);
  });

  test('parseSince accepts 24h, an ISO start, and rejects a bare word', () => {
    expect(parseSince('24h', 0)).toBe(24 * 60 * 60 * 1000);
    expect(parseSince('30m', 0)).toBe(30 * 60 * 1000);
    expect(parseSince(undefined, 5)).toBe(5);
    const now = Date.parse('2026-10-05T00:00:00.000Z');
    expect(parseSince('2026-10-04T00:00:00.000Z', 0, now)).toBe(24 * 60 * 60 * 1000);
    expect(() => parseSince('tomorrow', 0)).toThrow(/--since/);
    expect(() => parseSince('2026-10-06T00:00:00.000Z', 0, now)).toThrow(/not before now/);
  });

  test('markdown scorecard compares Elo, win rate, and record with the previous window', () => {
    const { layout } = emptyRoot();
    fs.mkdirSync(layout.ladderLogDir, { recursive: true });
    const now = Date.parse('2026-10-05T12:00:00.000Z');
    const hour = 60 * 60 * 1000;
    const row = (battleId: string, ts: number, outcome: 'win' | 'loss', eloAfter: number) => JSON.stringify({
      schema: 'jev.ladder-game.v1',
      kind: 'ladder-game',
      source: 'ladder',
      localServer: false,
      username: 'asad',
      format: 'gen9randombattle',
      battleId,
      ts,
      outcome,
      endReason: 'ko',
      turns: 12,
      eloAfter,
    });
    fs.writeFileSync(path.join(layout.ladderLogDir, 'games.jsonl'), [
      row('prior-win', now - 3 * hour, 'win', 1400),
      row('prior-loss', now - 2.5 * hour, 'loss', 1380),
      row('boundary', now - 2 * hour, 'loss', 1360),
      row('now-win', now - hour, 'win', 1500),
      row('now-win-2', now - 30 * 60 * 1000, 'win', 1520),
      row('now-loss', now - 10 * 60 * 1000, 'loss', 1510),
    ].join('\n') + '\n');
    const markdown = renderScorecard(layout, {
      now,
      since: '2026-10-05T10:00:00.000Z',
      markdown: true,
      processes: [],
      git: quietGit,
      scanProcesses: false,
    });
    expect(markdown.startsWith('# jev scorecard')).toBe(true);
    expect(markdown).toContain('vs prior');
    expect(markdown).toContain('1400 → 1380 (-20) on 2 games → 1360 → 1510 (+150) on 4 games');
    expect(markdown).toContain('50.0% → 50.0%');
    expect(markdown).toContain('1-1-0 on 2 games → 2-2-0 on 4 games');
    expect(markdown).toContain('end Elo +130 versus the previous window');
  });
});

describe('sentinel once --json', () => {
  test('prints current incidents and exits 1 when a P0 is open', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-sentinel-cli-'));
    writeTonightFixture(root);
    const result = spawnSync(path.join(process.cwd(), 'node_modules', '.bin', 'tsx'), ['src/ops/cli.ts', 'sentinel', '--once', '--json'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPS_DIR: path.join(root, 'ops'),
        LADDER_LOG_DIR: path.join(root, 'ladder'),
        LIVE_RUNS_DIR: path.join(root, 'live-runs'),
        JEV_DATA_DIR: path.join(root, 'data'),
        GRAPH_DB: path.join(root, 'graph.db'),
      },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    const body = JSON.parse(result.stdout) as { openP0: number; incidents: Array<{ checkId: string; status: string }> };
    expect(body.openP0).toBeGreaterThan(0);
    expect(body.incidents.some(item => item.checkId === 'species-count' && item.status === 'open')).toBe(true);
  });

  test('exits 0 and prints an empty incident list when no P0 is open', async () => {
    const { layout } = emptyRoot();
    const logs: string[] = [];
    const original = console.log;
    console.log = (line?: unknown) => {
      logs.push(String(line));
    };
    try {
      const code = await runSentinel(layout, { once: true, json: true, processes: [], git: quietGit });
      expect(code).toBe(0);
    } finally {
      console.log = original;
    }
    const body = JSON.parse(logs.at(-1) ?? '') as { openP0: number; incidents: unknown[] };
    expect(body.openP0).toBe(0);
    expect(body.incidents).toEqual([]);
  });
});

describe('invalid choice reasons', () => {
  test('adds reasons from invalidChoiceReasons when the field exists', () => {
    const { layout } = emptyRoot();
    fs.mkdirSync(layout.ladderLogDir, { recursive: true });
    const now = Date.now();
    const base = {
      schema: 'jev.ladder-game.v1',
      kind: 'ladder-game',
      source: 'ladder',
      localServer: false,
      username: 'asad',
      format: 'gen9randombattle',
      outcome: 'loss',
      endReason: 'ko',
      turns: 8,
      ts: now - 1000,
    };
    fs.writeFileSync(path.join(layout.ladderLogDir, 'games.jsonl'), [
      JSON.stringify({
        ...base,
        battleId: 'battle-reasons',
        invalidChoices: 0,
        invalidChoiceReasons: ["Can't switch: trapped", { reason: 'Move is disabled' }],
      }),
      JSON.stringify({ ...base, battleId: 'battle-count', invalidChoices: 2 }),
      JSON.stringify({
        type: 'error',
        battleId: 'battle-row',
        ts: now - 500,
        invalidChoiceReasons: ["Can't move: Dynamax is not active"],
      }),
    ].join('\n') + '\n');
    const result = scanOnce(layout, { now, processes: [], git: quietGit });
    const hits = result.hits.filter(hit => hit.id === 'invalid-choices');
    const reasons = hits.find(hit => hit.key === 'battle-reasons');
    const counted = hits.find(hit => hit.key === 'battle-count');
    const rowOnly = hits.find(hit => hit.key === 'battle-row');
    expect(reasons?.detail).toContain("Can't switch: trapped");
    expect(reasons?.detail).toContain('Move is disabled');
    expect(counted?.detail).toContain('invalidChoices=2');
    expect(counted?.detail).not.toContain('reasons:');
    expect(rowOnly?.detail).toContain("Can't move: Dynamax is not active");
  });
});

describe('sentinel docs', () => {
  test('the README names every check and its severity', () => {
    const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
    for (const check of CHECKS) {
      expect(readme).toContain(`| ${check.id} | ${check.severity} |`);
    }
  });

  test('the ops layout resolves under the repo by default', () => {
    const layout = layoutFromEnv(process.cwd(), {});
    expect(layout.opsDir).toBe(path.join(process.cwd(), 'state', 'ops'));
    expect(layout.ladderLogDir).toBe(path.join(process.cwd(), 'logs', 'ladder'));
  });
});
