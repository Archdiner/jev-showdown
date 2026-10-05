import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphDB } from '../../graph/db.js';
import { CHECKS } from './checks.js';
import { writeTonightFixture } from './fixtures.js';
import { acknowledge, incidentStore, linkIncident, loadIncidents, markFixing, openP0, resolveMatching } from './incidents.js';
import { AB_VERDICT_MIN_GAMES, buildScorecard, formatScorecard, judgeArms, parseSince } from './scorecard.js';
import { sprt } from '../../dashboard/stats.js';
import { loadContext, parseProcessTable, parsePs, scanProcesses, snapshotProcesses } from './load.js';
import { judge } from '../gatekeeper.js';
import { openDb } from '../db.js';
import { opsPaths } from '../paths.js';
import { readLabels } from '../labels-read.js';
import { readEvents } from './incidents.js';
import { layoutFromEnv, parseBaseline, renderScorecard, runSentinel, scanOnce } from './run.js';
import type { GitStatus, Layout, ObservedGame, ProcessSnapshot } from './types.js';

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
    liveRepoDir: null,
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
    expect(again.openP0).toBeGreaterThan(0);
    const events = readEvents(incidentStore(fixture.layout.opsDir).eventsPath);
    expect(events.filter(event => event.type === 'updated' && event.incidentId === duplicate?.id)).toEqual([]);
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
    expect(scanProcesses({ procRoot: missing })).toEqual([]);

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
  });
});

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


  test('an alive gatekeeper with a stale heartbeat is ops-worker-hung (macOS ps path)', () => {
    const { layout } = emptyRoot();
    const now = Date.now();
    fs.mkdirSync(layout.opsDir, { recursive: true });
    // Last beat is older than staleMs (60s). Process list still shows the worker.
    fs.writeFileSync(path.join(layout.opsDir, 'heartbeats.jsonl'), `${JSON.stringify({
      facility: 'gatekeeper',
      pid: 4242,
      ts: now - 120_000,
      status: 'ok',
      detail: 'recorded screen 115-85-0 accepted for live A/B',
    })}\n${JSON.stringify({
      facility: 'factory',
      pid: 4243,
      ts: now - 1_000,
      status: 'ok',
      detail: 'idle',
    })}\n`);
    const processes = [
      { pid: 4242, cmd: 'node /Users/me/jev/src/ops/cli.ts gatekeeper' },
      { pid: 4243, cmd: 'node /Users/me/jev/src/ops/cli.ts factory' },
    ];
    const result = scanOnce(layout, { now, processes, git: quietGit });
    expect(result.hits.map(hit => hit.id)).toContain('ops-worker-hung');
    const hung = result.hits.find(hit => hit.id === 'ops-worker-hung');
    expect(hung?.detail).toContain('gatekeeper');
    expect(hung?.detail).toContain('4242');
    // Missing would have fired if we ignored the alive pid; hung is the right signal.
    expect(result.hits.filter(hit => hit.id === 'ops-worker-missing' && hit.detail?.includes('gatekeeper'))).toHaveLength(0);
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

describe('ab share sentinel', () => {
  test('a realized share outside binomial noise is P2 after 15 games', () => {
    const { layout } = emptyRoot();
    fs.mkdirSync(layout.ladderLogDir, { recursive: true });
    const summary = (games: number, challengerGames: number) => ({
      games,
      ab: [
        {
          configId: 'champ',
          role: 'champion',
          configuredShare: 0.5,
          games: games - challengerGames,
          realizedShare: (games - challengerGames) / games,
        },
        {
          configId: 'exact-1ply-qw',
          role: 'challenger',
          configuredShare: 0.5,
          games: challengerGames,
          realizedShare: challengerGames / games,
        },
      ],
    });
    const file = path.join(layout.ladderLogDir, 'summary.json');
    fs.writeFileSync(file, JSON.stringify(summary(33, 5)));
    const fired = scanOnce(layout, { now: Date.now(), scanProcesses: false, git: quietGit });
    const hits = fired.hits.filter(item => item.id === 'ab-share-deviation');
    expect(hits.map(item => item.severity)).toEqual(['P2', 'P2']);
    expect(hits.map(item => item.key).sort()).toEqual(['champ', 'exact-1ply-qw']);
    expect(hits.find(item => item.key === 'exact-1ply-qw')?.detail).toContain('5/33');

    fs.writeFileSync(file, JSON.stringify(summary(33, 16)));
    const quiet = scanOnce(layout, { now: Date.now(), scanProcesses: false, git: quietGit });
    expect(quiet.hits.filter(item => item.id === 'ab-share-deviation')).toEqual([]);

    fs.writeFileSync(file, JSON.stringify(summary(14, 0)));
    const short = scanOnce(layout, { now: Date.now(), scanProcesses: false, git: quietGit });
    expect(short.hits.filter(item => item.id === 'ab-share-deviation')).toEqual([]);
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
    expect(text).toContain('queued 0');
    expect(text).toContain('loop health');
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

  test('arm verdicts stay pending under 40 games and then follow the cumulative record', () => {
    const short = judgeArms(armGames('exact-1ply-qw', 39, 'loss'));
    expect(short).toHaveLength(1);
    expect(short[0]).toMatchObject({ configId: 'exact-1ply-qw', wins: 0, losses: 39, games: 39, verdict: null });
    expect(short[0].wilsonLow).not.toBeNull();
    expect(short[0].sprt).toBe('continue');

    const ready = judgeArms([
      ...armGames('exact-1ply-qw', 20, 'loss', 'batch-a'),
      ...armGames('exact-1ply-qw', 20, 'win', 'batch-b'),
    ]);
    expect(ready[0].games).toBe(40);
    expect(ready[0].wins).toBe(20);
    expect(ready[0].losses).toBe(20);
    expect(ready[0].verdict).toBe(sprt(20, 20));
    expect(ready[0].wilsonLow).toBeLessThan(0.5);
    expect(ready[0].wilsonHigh).toBeGreaterThan(0.5);

    const decided = judgeArms(armGames('exact-1ply-qw', 120, 'loss'));
    expect(decided[0].games).toBeGreaterThanOrEqual(AB_VERDICT_MIN_GAMES);
    expect(decided[0].verdict).toBe('reject');
    expect(decided[0].verdict).toBe(sprt(0, 120));

    const { layout } = emptyRoot();
    fs.mkdirSync(layout.ladderLogDir, { recursive: true });
    const now = Date.parse('2026-10-05T12:00:00.000Z');
    const row = (battleId: string, configId: string) => JSON.stringify({
      schema: 'jev.ladder-game.v1',
      kind: 'ladder-game',
      source: 'ladder',
      localServer: false,
      username: 'asad',
      format: 'gen9randombattle',
      battleId,
      configId,
      ts: now - 60_000,
      outcome: 'loss',
      endReason: 'ko',
      turns: 12,
      eloAfter: 1400,
    });
    fs.writeFileSync(path.join(layout.ladderLogDir, 'games.jsonl'), [
      row('g1', 'exact-1ply-qw'),
      row('g2', 'exact-1ply-qw'),
    ].join('\n') + '\n');
    const text = renderScorecard(layout, {
      now,
      since: '1h',
      processes: [],
      git: quietGit,
      scanProcesses: false,
    });
    expect(text).toContain('exact-1ply-qw  0-2-0  n=2');
    expect(text).toContain('verdict=pending');
  });
});

function armGames(configId: string, count: number, outcome: 'win' | 'loss', tag = 'batch'): ObservedGame[] {
  const games: ObservedGame[] = [];
  for (let index = 0; index < count; index++) {
    games.push({
      file: 'games.jsonl',
      line: index + 1,
      battleId: `${tag}-${configId}-${index}`,
      ts: index,
      turns: 8,
      outcome,
      endReason: 'ko',
      eloBefore: null,
      eloAfter: null,
      invalid: 0,
      invalidChoiceReasons: [],
      crashes: 0,
      fallbacks: 0,
      minTimerMarginSec: 20,
      replayUrl: 'https://replay.pokemonshowdown.com/gen9randombattle-1',
      replayStatus: 'confirmed',
      local: false,
      ladder: true,
      gitSha: tag,
      runId: null,
      batchLabel: null,
      variantId: null,
      configId,
      username: 'asad',
      format: 'gen9randombattle',
      schema: 'jev.ladder-game.v1',
      decisions: 4,
      latencyP95Ms: 100,
      phantom: false,
      source: 'ladder',
    });
  }
  return games;
}

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

describe('genuine game dropped', () => {
  function contamination(layout: Layout, row: Record<string, unknown>): void {
    fs.mkdirSync(layout.ladderLogDir, { recursive: true });
    fs.appendFileSync(path.join(layout.ladderLogDir, 'games.contamination.jsonl'), `${JSON.stringify(row)}\n`);
  }

  test('a non-owning-process drop whose owner pid is dead is P1 without /proc', () => {
    const missing = path.join(os.tmpdir(), `jev-noproc-dead-${process.pid}`);
    expect(scanProcesses({ procRoot: missing })).toEqual([]);
    const { layout } = emptyRoot();
    const now = Date.now();
    contamination(layout, {
      schema: 'jev.game-contamination.v1',
      battleId: 'battle-gen9randombattle-2693017811',
      pid: 42482,
      ts: now - 1000,
      reason: 'non-owning-process',
      note: 'owner pid 35079',
    });
    const result = scanOnce(layout, { now, scanProcesses: false, git: quietGit, pidAlive: () => false });
    const hit = result.hits.find(item => item.id === 'genuine-game-dropped');
    expect(hit?.severity).toBe('P1');
    expect(hit?.detail).toContain('owner pid 35079 is not alive');
    expect(hit?.detail).toContain('battle-gen9randombattle-2693017811');
  });

  test('a drop whose owner run is not the writer run is P1 even when that pid is alive', () => {
    const { layout } = emptyRoot();
    const now = Date.now();
    contamination(layout, {
      schema: 'jev.game-contamination.v1',
      battleId: 'battle-gen9randombattle-2693017822',
      pid: 42482,
      ownerPid: 35079,
      ts: now - 1000,
      reason: 'non-owning-process',
      note: 'owner pid 35079 run batch-12',
      runId: 'batch-13',
    });
    const result = scanOnce(layout, { now, scanProcesses: false, git: quietGit, pidAlive: () => true });
    const hit = result.hits.find(item => item.id === 'genuine-game-dropped');
    expect(hit?.severity).toBe('P1');
    expect(hit?.detail).toContain('owner run batch-12 is not writer run batch-13');
  });

  test('a live owner on the same run is not a dropped genuine game', () => {
    const { layout } = emptyRoot();
    const now = Date.now();
    contamination(layout, {
      schema: 'jev.game-contamination.v1',
      battleId: 'battle-gen9randombattle-1',
      pid: 42482,
      ownerPid: 35079,
      ownerRunId: 'batch-12',
      runId: 'batch-12',
      ts: now - 1000,
      reason: 'non-owning-process',
      note: 'owner pid 35079 run batch-12',
    });
    const result = scanOnce(layout, { now, scanProcesses: false, git: quietGit, pidAlive: () => true });
    expect(result.hits.map(item => item.id)).not.toContain('genuine-game-dropped');
  });

  test('finished live heartbeats with no live-games row are P1', () => {
    const { layout } = emptyRoot();
    const now = Date.now();
    fs.writeFileSync(path.join(layout.opsDir, 'heartbeats.jsonl'), [
      JSON.stringify({ facility: 'live', pid: 15, ts: now - 2000, status: 'ok', detail: 'localbot win local' }),
      JSON.stringify({ facility: 'live', pid: 15, ts: now - 1000, status: 'ok', detail: 'localbot loss local' }),
      '',
    ].join('\n'));
    const result = scanOnce(layout, { now, scanProcesses: false, git: quietGit });
    const hit = result.hits.find(item => item.id === 'genuine-game-dropped');
    expect(hit?.severity).toBe('P1');
    expect(hit?.detail).toContain('2 finished live heartbeats');
    expect(hit?.detail).toContain('0 rows');
  });

  test('a heartbeat within two seconds of the row is not a gap', () => {
    const { layout } = emptyRoot();
    const now = Date.now();
    const rowTs = now - 1000;
    fs.mkdirSync(layout.opsDir, { recursive: true });
    fs.writeFileSync(path.join(layout.opsDir, 'live-games.jsonl'), `${JSON.stringify({
      schema: 'jev.ladder-game.v1',
      kind: 'ladder-game',
      source: 'ops',
      localServer: true,
      battleId: 'battle-local-1',
      ts: rowTs,
      outcome: 'win',
      endReason: 'ko',
      turns: 4,
      username: 'localbot',
      format: 'gen9randombattle',
    })}\n`);
    fs.writeFileSync(path.join(layout.opsDir, 'heartbeats.jsonl'), `${JSON.stringify({
      facility: 'live',
      pid: 15,
      ts: rowTs + 100,
      status: 'ok',
      detail: 'localbot win local',
    })}\n`);
    const result = scanOnce(layout, { now, scanProcesses: false, git: quietGit });
    expect(result.hits.map(item => item.id)).not.toContain('genuine-game-dropped');
  });

  test('a progress line with no row for that run is P1', () => {
    const { layout } = emptyRoot();
    const now = Date.now();
    fs.mkdirSync(layout.liveRunsDir, { recursive: true });
    fs.writeFileSync(path.join(layout.liveRunsDir, 'batch-13.log'), [
      '[ladder] pid=42482 run=batch-13',
      '[ladder] 1/10 win vs foe turns=12 invalid=0 crashes=0 fallbacks=0 elo=1074',
      '',
    ].join('\n'));
    const result = scanOnce(layout, { now, scanProcesses: false, git: quietGit });
    const hit = result.hits.find(item => item.id === 'genuine-game-dropped');
    expect(hit?.severity).toBe('P1');
    expect(hit?.detail).toContain('run batch-13 logged 1 finished game and 0 rows were written');
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
    expect(layout.liveRepoDir).toBeNull();
    const live = layoutFromEnv(process.cwd(), { LIVE_REPO_DIR: '~/jev-search' });
    expect(live.liveRepoDir).toBe(path.join(os.homedir(), 'jev-search'));
  });
});

const PS_84701 = `  PID  PPID  PGID STARTED                      COMMAND
84701     1 84701 Mon Oct  5 23:52:01 2026     node src/cli/ladder.ts
    1     0     1 Mon Oct  5 00:00:01 2026     /sbin/launchd
`;

function ladderRow(row: Record<string, unknown>): string {
  return JSON.stringify({
    schema: 'jev.ladder-game.v1',
    kind: 'ladder-game',
    source: 'ladder',
    localServer: false,
    username: 'asad',
    format: 'gen9randombattle',
    outcome: 'loss',
    endReason: 'ko',
    turns: 12,
    invalidChoices: 0,
    crashes: 0,
    fallbacks: 0,
    minTimerMarginSec: 8,
    eloBefore: 1510,
    eloAfter: 1500,
    replayUrl: 'https://replay.pokemonshowdown.com/gen9randombattle-1',
    replayStatus: 'confirmed',
    ...row,
  });
}

function fingerprint(root: string, incidents: Array<Record<string, unknown>>): string {
  const normalize = (value: unknown): unknown => {
    if (typeof value === 'string') return value.split(root).join('ROOT');
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = normalize((value as Record<string, unknown>)[key]);
      return out;
    }
    return value;
  };
  return JSON.stringify(normalize(incidents));
}

describe('sentinel accuracy', () => {
  test('ps lists a live ladder pid and runner-down does not page for it', () => {
    const parsed = parsePs(PS_84701);
    expect(parsed.find(row => row.pid === 84701)?.cmd).toContain('src/cli/ladder.ts');
    expect(parsed.find(row => row.pid === 84701)?.ppid).toBe(1);
    const { layout } = emptyRoot();
    const now = Date.now();
    fs.mkdirSync(layout.liveRunsDir, { recursive: true });
    fs.writeFileSync(path.join(layout.liveRunsDir, 'run.json'), JSON.stringify({
      runId: 'run',
      pid: 84701,
      username: 'asad',
      local: false,
      startedAt: now - 60_000,
    }));
    const processes = parsed.filter(row => row.cmd.includes('ladder.ts'));
    const up = scanOnce(layout, { now, processes, git: quietGit });
    expect(up.hits.map(hit => hit.id)).not.toContain('runner-down');
    const backed = scanOnce(layout, {
      now,
      processes: [],
      pidAlive: pid => pid === 84701,
      git: quietGit,
    });
    expect(backed.hits.map(hit => hit.id)).not.toContain('runner-down');
    const down = scanOnce(layout, { now: now + 1, processes: [], git: quietGit });
    expect(down.hits.map(hit => hit.id)).toContain('runner-down');
  });

  test('scanProcesses uses ps and reads /proc only for the environment', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-proc-'));
    const proc = path.join(root, 'proc', '84701');
    fs.mkdirSync(proc, { recursive: true });
    fs.writeFileSync(path.join(proc, 'cmdline'), 'node\0src/cli/ladder.ts\0');
    fs.writeFileSync(path.join(proc, 'environ'), 'LADDER_LOG_DIR=/tmp/ladder\0');
    const found = scanProcesses({ ps: () => PS_84701, procRoot: path.join(root, 'proc') });
    expect(found.map(row => row.pid)).toEqual([84701]);
    expect(found[0].env?.LADDER_LOG_DIR).toBe('/tmp/ladder');
    const psOnly = scanProcesses({ ps: () => PS_84701, procRoot: path.join(root, 'missing') });
    expect(psOnly.map(row => row.pid)).toEqual([84701]);
    expect(psOnly[0].env).toBeUndefined();
    const procOnly = scanProcesses({ ps: () => '', procRoot: path.join(root, 'proc') });
    expect(procOnly).toEqual([]);
  });

  test('collectRows handles large JSONL files without stack overflow', () => {
    const { layout } = emptyRoot();
    fs.mkdirSync(layout.ladderLogDir, { recursive: true });
    const rows: string[] = [];
    const baseRow = {
      schema: 'jev.ladder-game.v1',
      kind: 'ladder-game',
      source: 'ladder',
      localServer: false,
      battleId: 'battle-test',
      ts: Date.now(),
      outcome: 'win',
      endReason: 'ko',
      turns: 10,
      username: 'bot',
      format: 'gen9randombattle',
      eloAfter: 1500,
      invalidChoices: 0,
      crashes: 0,
      fallbacks: 0,
      decisions: 10,
      minTimerMarginSec: 5,
      replayUrl: 'https://replay.pokemonshowdown.com/test',
      replayStatus: 'confirmed',
    };
    for (let index = 0; index < 250_000; index++) {
      rows.push(JSON.stringify({ ...baseRow, battleId: `battle-${index}` }));
    }
    fs.writeFileSync(path.join(layout.ladderLogDir, 'large.jsonl'), rows.join('\n'));
    expect(() => {
      const ctx = loadContext(layout, { now: Date.now(), processes: [], git: quietGit });
      expect(ctx.games.length).toBeGreaterThan(0);
    }).not.toThrow();
  });

  test('LIVE_REPO_DIR checks name the live checkout separately from ops', () => {
    const { layout } = emptyRoot();
    const live = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-live-repo-'));
    layout.liveRepoDir = live;
    const now = Date.now();
    const drain = path.join(live, 'state', 'DRAIN');
    fs.mkdirSync(path.dirname(drain), { recursive: true });
    fs.writeFileSync(drain, '');
    const old = (now - 11 * 60 * 1000) / 1000;
    fs.utimesSync(drain, old, old);
    fs.writeFileSync(path.join(live, 'state', 'ladder-asad.lock'), JSON.stringify({ pid: 99999, username: 'asad', host: 'mac', startedAt: '2026-10-05T00:00:00.000Z' }));
    const result = scanOnce(layout, {
      now,
      processes: [],
      git: quietGit,
      liveGit: behindGit,
    });
    const behind = result.hits.filter(hit => hit.id === 'checkout-behind');
    expect(behind.map(hit => hit.key)).toEqual(['live']);
    expect(behind[0].detail).toContain(live);
    expect(behind[0].detail).toContain('live checkout');
    const drains = result.hits.filter(hit => hit.id === 'drain-pending');
    expect(drains.some(hit => hit.detail.includes('live checkout') && hit.detail.includes(drain))).toBe(true);
    const locks = result.hits.filter(hit => hit.id === 'stale-lock');
    expect(locks.some(hit => hit.detail.includes('live checkout'))).toBe(true);
  });

  test('LADDER_LOG_DIR git root is the ladder checkout for behind and drain', () => {
    const ops = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-ops-'));
    const live = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-search-'));
    execFileSync('git', ['init'], { cwd: live, stdio: 'ignore' });
    const ladder = path.join(live, 'logs', 'ladder');
    fs.mkdirSync(ladder, { recursive: true });
    const layout = layoutFromEnv(ops, { LADDER_LOG_DIR: ladder });
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: live, encoding: 'utf8' }).trim();
    expect(layout.liveRepoDir).toBe(top);
    expect(path.resolve(layout.cwd)).toBe(path.resolve(ops));
    const now = Date.now();
    const drain = path.join(live, 'state', 'DRAIN');
    fs.mkdirSync(path.dirname(drain), { recursive: true });
    fs.writeFileSync(drain, '');
    const old = (now - 11 * 60 * 1000) / 1000;
    fs.utimesSync(drain, old, old);
    const result = scanOnce(layout, { now, processes: [], git: quietGit, liveGit: behindGit });
    const behind = result.hits.filter(hit => hit.id === 'checkout-behind');
    expect(behind.map(hit => hit.key)).toEqual(['live']);
    expect(behind[0].detail).toContain(top);
    expect(behind[0].detail).not.toContain(ops);
    const drains = result.hits.filter(hit => hit.id === 'drain-pending');
    expect(drains.some(hit => hit.detail.includes('live checkout') && hit.detail.includes(drain))).toBe(true);
    expect(drains.some(hit => hit.detail.includes(ops))).toBe(false);
  });

  test('a repeat scan keeps count on the snapshot and does not append an updated line', () => {
    const { layout } = emptyRoot();
    fs.writeFileSync(path.join(layout.dataDir, 'gen9-stats.json'), speciesMap(1));
    const now = Date.now();
    scanOnce(layout, { now, processes: [], git: quietGit, maxEventBytes: 1024 * 1024 });
    scanOnce(layout, { now: now + 1000, processes: [], git: quietGit });
    const store = incidentStore(layout.opsDir);
    const incident = loadIncidents(store)[0];
    expect(incident.count).toBe(2);
    expect(incident.lastSeen).toBe(now + 1000);
    const events = readEvents(store.eventsPath);
    expect(events.map(event => event.type)).toEqual(['opened']);
  });

  test('the event log rotates by size and the snapshot keeps the incident', () => {
    const { layout } = emptyRoot();
    fs.writeFileSync(path.join(layout.dataDir, 'gen9-stats.json'), speciesMap(1));
    const now = Date.now();
    scanOnce(layout, { now, processes: [], git: quietGit, maxEventBytes: 1 });
    const store = incidentStore(layout.opsDir);
    expect(fs.existsSync(`${store.eventsPath}.1`)).toBe(true);
    expect(loadIncidents(store)[0].status).toBe('open');
    expect(loadIncidents(store)[0].checkId).toBe('species-count');
  });

  test('timer-margin-null skips local games and battle-local rows', () => {
    const { layout } = emptyRoot();
    const now = Date.now();
    fs.mkdirSync(layout.ladderLogDir, { recursive: true });
    fs.mkdirSync(layout.opsDir, { recursive: true });
    fs.writeFileSync(path.join(layout.ladderLogDir, 'games.jsonl'), [
      ladderRow({ battleId: 'battle-local-9', ts: now - 1000, localServer: true, username: 'localbot', minTimerMarginSec: null, source: 'local' }),
      ladderRow({ battleId: 'battle-real', ts: now - 1000, minTimerMarginSec: null }),
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(layout.opsDir, 'live-games.jsonl'), `${ladderRow({
      battleId: 'battle-from-ops',
      ts: now - 1000,
      localServer: true,
      username: 'localbot',
      minTimerMarginSec: null,
      source: 'ops',
    })}\n`);
    const result = scanOnce(layout, { now, processes: [], git: quietGit });
    const hits = result.hits.filter(hit => hit.id === 'timer-margin-null');
    expect(hits.map(hit => hit.key)).toEqual(['battle-real']);
  });

  test('a 1000-floor forfeit is consistent and mixed ratings do not compare separate rows', () => {
    const { layout } = emptyRoot();
    const now = Date.now();
    fs.mkdirSync(layout.ladderLogDir, { recursive: true });
    fs.writeFileSync(path.join(layout.ladderLogDir, 'games.jsonl'), [
      ladderRow({ battleId: 'battle-floor', ts: now - 2000, endReason: 'our-forfeit', outcome: 'loss', eloBefore: 1000, eloAfter: null }),
      ladderRow({ battleId: 'battle-missing-elo', ts: now - 1000, endReason: 'our-forfeit', outcome: 'loss', eloBefore: 1400, eloAfter: null }),
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(layout.opsDir, 'heartbeats.jsonl'), [
      JSON.stringify({ facility: 'live', pid: 1, ts: now - 1000, status: 'ok', detail: 'localbot win rating 1000', scope: 'local' }),
      JSON.stringify({ facility: 'live', pid: 1, ts: now - 900, status: 'ok', detail: 'asad loss rating 1510', scope: 'ladder' }),
    ].join('\n') + '\n');
    const separate = scanOnce(layout, { now, processes: [], git: quietGit });
    const elo = separate.hits.filter(hit => hit.id === 'elo-null-on-forfeit');
    expect(elo.map(hit => hit.key)).toEqual(['battle-missing-elo']);
    expect(separate.hits.map(hit => hit.id)).not.toContain('mixed-ratings');
    fs.writeFileSync(path.join(layout.opsDir, 'heartbeats.jsonl'), `${JSON.stringify({
      facility: 'live', pid: 1, ts: now - 1000, status: 'ok', scope: 'local', detail: 'localbot ladder rating 1510 on sim3.psim.us',
    })}\n`);
    const mixed = scanOnce(layout, { now: now + 1, processes: [], git: quietGit });
    expect(mixed.hits.map(hit => hit.id)).toContain('mixed-ratings');
  });

  test('two pids on a result line for one battle are a duplicate runner', () => {
    const { layout } = emptyRoot();
    const now = Date.now();
    fs.mkdirSync(layout.ladderLogDir, { recursive: true });
    const battle = 'battle-gen9randombattle-1';
    fs.writeFileSync(path.join(layout.ladderLogDir, 'games.jsonl'), [
      JSON.stringify({ type: 'result', schema: 'jev.ladder-game.v1', battleId: battle, ts: now - 2000, pid: 2201, username: 'asad', outcome: 'loss', endReason: 'our-forfeit', turns: 4 }),
      JSON.stringify({ type: 'result', schema: 'jev.ladder-game.v1', battleId: battle, ts: now - 1900, pid: 2202, username: 'asad', outcome: 'loss', endReason: 'our-forfeit', turns: 4 }),
    ].join('\n') + '\n');
    const result = scanOnce(layout, { now, processes: [], git: quietGit });
    expect(result.hits.map(hit => hit.id)).toContain('duplicate-ladder-runners');
  });

  test('batches count unique games.jsonl battles and skip an aborted 0-game run', () => {
    const { layout } = emptyRoot();
    const now = Date.now();
    fs.mkdirSync(layout.ladderLogDir, { recursive: true });
    const good = Array.from({ length: 6 }, (_, index) => ladderRow({
      battleId: `battle-batch-${index}`,
      ts: now - 60_000 + index,
      outcome: index < 2 ? 'win' : 'loss',
      gitSha: 'e5e5fe6',
      eloAfter: 1500 + index,
    }));
    const aborted = Array.from({ length: 3 }, (_, index) => ladderRow({
      battleId: `battle-abort-${index}`,
      ts: now - 30_000 + index,
      gitSha: 'dead000',
      outcome: 'loss',
    }));
    fs.writeFileSync(path.join(layout.ladderLogDir, 'games.jsonl'), [...good, ...aborted].join('\n') + '\n');
    fs.writeFileSync(path.join(layout.opsDir, 'live-games.jsonl'), good.map(line => line.replace('"source":"ladder"', '"source":"ops"')).join('\n') + '\n');
    fs.writeFileSync(path.join(layout.ladderLogDir, 'asad-battle-gen9randombattle-1.jsonl'), `${JSON.stringify({
      type: 'result', schema: 'jev.ladder-game.v1', battleId: 'battle-batch-0', ts: now - 1000, outcome: 'win', turns: 12, gitSha: 'e5e5fe6', username: 'asad',
    })}\n`);
    fs.writeFileSync(path.join(layout.ladderLogDir, 'summary.json'), JSON.stringify({ games: 0, wins: 0, gitSha: 'dead000', requested: 10 }));
    const text = renderScorecard(layout, { now, since: '24h', processes: [], git: quietGit, scanProcesses: false });
    expect(text).toContain('e5e5fe6');
    expect(text).toContain('2-4-0');
    expect(text).toContain('n=6');
    expect(text).not.toContain('dead000');
    expect(text).not.toContain('n=15');
    expect(text).toContain('live runner');
    expect(text).toContain('ops workers');
  });

  test('scorecard uptime and batch records come from games.jsonl batchLabel and runId', () => {
    const { layout } = emptyRoot();
    const now = Date.parse('2026-10-05T23:52:00.000Z');
    fs.mkdirSync(layout.ladderLogDir, { recursive: true });
    const batch11 = [
      ladderRow({
        battleId: 'battle-b11-a',
        ts: now - 40 * 60 * 1000,
        outcome: 'win',
        gitSha: 'c105e48',
        runId: 'r11',
        batchLabel: 'batch 11',
      }),
      ladderRow({
        battleId: 'battle-b11-b',
        ts: now - 10 * 60 * 1000,
        outcome: 'win',
        gitSha: 'c105e48',
        runId: 'r11',
        batchLabel: 'batch 11',
      }),
    ];
    const batch10 = ladderRow({
      battleId: 'battle-b10',
      ts: now - 5 * 60 * 1000,
      outcome: 'loss',
      gitSha: 'c105e48',
      runId: 'r10',
      batchLabel: 'batch 10',
    });
    fs.writeFileSync(path.join(layout.ladderLogDir, 'games.jsonl'), [...batch11, batch10].join('\n') + '\n');
    fs.writeFileSync(path.join(layout.opsDir, 'live-games.jsonl'), batch11.map(line => line.replace('"source":"ladder"', '"source":"ops"')).join('\n') + '\n');
    fs.writeFileSync(path.join(layout.opsDir, 'heartbeats.jsonl'), `${JSON.stringify({
      facility: 'factory', pid: 1, ts: now - 50 * 60 * 1000, status: 'error',
    })}\n`);
    const text = renderScorecard(layout, { now, since: '1h', processes: [], git: quietGit, scanProcesses: false });
    expect(text).toContain('live runner  50.0%');
    expect(text).toContain('games.jsonl play spans');
    expect(text).toContain('batch 11 r11');
    expect(text).toContain('batch 10 r10');
    expect(text).toMatch(/batch 11 r11\s+2-0-0\s+100\.0%\s+n=2/);
    expect(text).toMatch(/batch 10 r10\s+0-1-0\s+0\.0%\s+n=1/);
    // The total 2-1-0 can appear in vs prior and variants sections, just not as a batch
    expect(text).toContain('2-1-0');
    expect(text).toContain('win rate   66.7%  2-1-0 on 3 games');
    expect(text).toContain('record     0-0-0 on 0 games → 2-1-0 on 3 games');
  });

  test('opened counts incidents in the file, and a ledger ref is on the scorecard', () => {
    const { layout } = emptyRoot();
    fs.writeFileSync(path.join(layout.dataDir, 'gen9-stats.json'), speciesMap(1));
    const now = Date.now();
    scanOnce(layout, { now, processes: [], git: quietGit });
    const store = incidentStore(layout.opsDir);
    const id = loadIncidents(store)[0].id;
    fs.appendFileSync(store.eventsPath, `${JSON.stringify({ ts: now, type: 'opened', incidentId: 'inc-extra', checkId: 'species-count', key: 'extra', severity: 'P0', title: 'extra', status: 'open' })}\n`);
    expect(linkIncident(store, id, 'INC-007', now + 1)).toBeNull();
    const ctx = loadContext(layout, { now: now + 2, processes: [], git: quietGit, scanProcesses: false });
    const incidents = loadIncidents(store);
    const card = buildScorecard(ctx, incidents, readEvents(store.eventsPath), 24 * 60 * 60 * 1000);
    expect(card.reliability.opened).toBe(incidents.filter(item => item.firstSeen >= now - 24 * 60 * 60 * 1000).length);
    expect(card.reliability.opened).toBe(1);
    expect(card.reliability.openP0).toBe(openP0(incidents));
    expect(formatScorecard(card)).toContain('[INC-007]');
  });

  test('resolve --sha and --before close history with a reason', () => {
    const { layout } = emptyRoot();
    const now = Date.parse('2026-10-05T23:00:00.000Z');
    fs.mkdirSync(layout.ladderLogDir, { recursive: true });
    fs.writeFileSync(path.join(layout.ladderLogDir, 'games.jsonl'), `${ladderRow({
      battleId: 'battle-old',
      ts: now - 60_000,
      invalidChoices: 2,
      gitSha: 'e7a9497',
      runId: 'old-run',
    })}\n`);
    scanOnce(layout, { now, processes: [], git: quietGit, baselineMs: null });
    const store = incidentStore(layout.opsDir);
    const resolved = resolveMatching(store, { sha: 'e7a9497' }, 'fixed after e7a9497', now + 1);
    expect(resolved.error).toBeNull();
    expect(resolved.ids.length).toBe(1);
    const incident = loadIncidents(store)[0];
    expect(incident.status).toBe('resolved');
    expect(incident.rootCause).toBe('fixed after e7a9497');
    expect(incident.inBaseline).toBe(false);

    const older = emptyRoot();
    fs.mkdirSync(older.layout.ladderLogDir, { recursive: true });
    fs.writeFileSync(path.join(older.layout.ladderLogDir, 'games.jsonl'), `${ladderRow({
      battleId: 'battle-before',
      ts: now - 2 * 60 * 60 * 1000,
      invalidChoices: 1,
      gitSha: '085aaa6',
      runId: 'earlier',
    })}\n`);
    scanOnce(older.layout, { now, processes: [], git: quietGit, baselineMs: null });
    const olderStore = incidentStore(older.layout.opsDir);
    const byTime = resolveMatching(olderStore, { before: now - 60 * 60 * 1000 }, 'before the cutoff', now + 2);
    expect(byTime.error).toBeNull();
    expect(byTime.ids.length).toBe(1);
    expect(loadIncidents(olderStore)[0].rootCause).toBe('before the cutoff');
    expect(loadIncidents(olderStore)[0].status).toBe('resolved');
  });

  test('parseBaseline accepts an ISO instant', () => {
    const now = Date.parse('2026-10-05T23:00:00.000Z');
    expect(parseBaseline('2026-10-05T22:00:00.000Z', now)).toBe(Date.parse('2026-10-05T22:00:00.000Z'));
    expect(parseBaseline('30m', now)).toBe(now - 30 * 60 * 1000);
  });

  test('--once exits 0 when the only P0 is acknowledged', async () => {
    const { layout } = emptyRoot();
    fs.writeFileSync(path.join(layout.dataDir, 'gen9-stats.json'), speciesMap(1));
    const now = Date.now();
    const opened = scanOnce(layout, { now, processes: [], git: quietGit });
    expect(opened.openP0).toBe(1);
    const store = incidentStore(layout.opsDir);
    expect(acknowledge(store, loadIncidents(store)[0].id, now + 1)).toBeNull();
    const logs: string[] = [];
    const original = console.log;
    console.log = (line?: unknown) => {
      logs.push(String(line));
    };
    try {
      const code = await runSentinel(layout, { once: true, json: true, now: now + 2, processes: [], git: quietGit });
      expect(code).toBe(0);
    } finally {
      console.log = original;
    }
    const body = JSON.parse(logs.at(-1) ?? '') as { openP0: number };
    expect(body.openP0).toBe(0);
    expect(loadIncidents(store)[0].status).toBe('acknowledged');
  });

  test('daemon and once agree, and a fresh per-game P0 stays open', async () => {
    const now = Date.parse('2026-10-05T23:52:00.000Z');
    const write = (root: string): Layout => {
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
      fs.mkdirSync(layout.liveRunsDir, { recursive: true });
      fs.mkdirSync(layout.dataDir, { recursive: true });
      fs.writeFileSync(path.join(layout.dataDir, 'gen9-stats.json'), speciesMap(500));
      fs.writeFileSync(path.join(layout.liveRunsDir, 'current.json'), JSON.stringify({
        runId: 'current',
        pid: 84701,
        username: 'asad',
        local: false,
        startedAt: now - 30 * 60 * 1000,
        gitSha: 'e5e5fe6',
      }));
      fs.writeFileSync(path.join(layout.ladderLogDir, 'games.jsonl'), [
        ladderRow({
          battleId: 'battle-historical',
          ts: now - 2 * 60 * 60 * 1000,
          invalidChoices: 2,
          gitSha: '0312c5a',
          runId: 'old',
        }),
        ladderRow({
          battleId: 'battle-gen9randombattle-2692998479',
          ts: now - 60_000,
          invalidChoices: 2,
          gitSha: 'e5e5fe6',
          runId: 'current',
        }),
        ladderRow({
          battleId: 'battle-pass',
          ts: now - 30_000,
          outcome: 'win',
          gitSha: 'e5e5fe6',
          runId: 'current',
        }),
      ].join('\n') + '\n');
      return layout;
    };
    const onceLayout = write(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-once-')));
    const daemonLayout = write(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-daemon-')));
    const shared = {
      now,
      processes: [{ pid: 84701, cmd: 'node src/cli/ladder.ts --username asad', env: {} }],
      git: quietGit,
      since: '2026-10-05T23:22:00.000Z',
      episodePassGames: 1,
    };
    const logs: string[] = [];
    const original = console.log;
    console.log = (line?: unknown) => {
      logs.push(String(line));
    };
    let onceCode = 1;
    let daemonCode = 0;
    try {
      onceCode = await runSentinel(onceLayout, { ...shared, once: true, json: true });
      daemonCode = await runSentinel(daemonLayout, { ...shared, once: false, scans: 1, json: true });
    } finally {
      console.log = original;
    }
    expect(onceCode).toBe(daemonCode);
    expect(onceCode).toBe(1);
    const onceBody = JSON.parse(fs.readFileSync(path.join(onceLayout.opsDir, 'incidents.json'), 'utf8')) as { incidents: Array<Record<string, unknown>> };
    const daemonBody = JSON.parse(fs.readFileSync(path.join(daemonLayout.opsDir, 'incidents.json'), 'utf8')) as { incidents: Array<Record<string, unknown>> };
    expect(fingerprint(onceLayout.cwd, onceBody.incidents)).toBe(fingerprint(daemonLayout.cwd, daemonBody.incidents));
    const fresh = onceBody.incidents.find(item => item.checkId === 'invalid-choices') as {
      status: string;
      resolvedAt: number | null;
      clearSince: number | null;
      firstSeen: number;
      count: number;
      gitSha: string;
      key: string;
      detail: string;
      evidence: Array<{ detail: string }>;
      inBaseline: boolean;
    };
    expect(fresh.status).toBe('open');
    expect(fresh.resolvedAt).toBeNull();
    expect(fresh.clearSince).toBeNull();
    expect(fresh.firstSeen).toBe(now);
    expect(fresh.gitSha).toBe('e5e5fe6');
    expect(fresh.key).toBe('run:current');
    expect(fresh.count).toBe(1);
    expect(fresh.inBaseline).toBe(true);
    expect(JSON.stringify(fresh.evidence)).toContain('2692998479');
    expect(JSON.stringify(fresh)).not.toContain('0312c5a');
    expect(onceBody.incidents.filter(item => item.checkId === 'invalid-choices')).toHaveLength(1);
    const ctx = loadContext(onceLayout, { now, processes: shared.processes, git: quietGit, baselineMs: Date.parse(shared.since) });
    const card = buildScorecard(ctx, loadIncidents(incidentStore(onceLayout.opsDir)), [], 24 * 60 * 60 * 1000);
    expect(card.reliability.openP0).toBe(openP0(loadIncidents(incidentStore(onceLayout.opsDir))));
    const again = scanOnce(onceLayout, { ...shared, now: now + 1000, episodePassGames: 1 });
    const after = loadIncidents(incidentStore(onceLayout.opsDir)).find(item => item.checkId === 'invalid-choices');
    expect(after?.status).toBe('resolved');
    expect(after?.resolvedAt).not.toBe(after?.firstSeen);
    expect(again.openP0).toBe(0);
    fs.appendFileSync(path.join(onceLayout.ladderLogDir, 'games.jsonl'), `${ladderRow({
      battleId: 'battle-old-again',
      ts: now - 3 * 60 * 60 * 1000,
      invalidChoices: 4,
      gitSha: '0312c5a',
      runId: 'old',
    })}\n`);
    scanOnce(onceLayout, { ...shared, now: now + 2000 });
    const stayed = loadIncidents(incidentStore(onceLayout.opsDir)).find(item => item.checkId === 'invalid-choices');
    expect(stayed?.status).toBe('resolved');
  });
});
