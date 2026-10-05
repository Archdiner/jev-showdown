import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphDB } from '../../graph/db.js';
import { CHECKS } from './checks.js';
import { writeTonightFixture } from './fixtures.js';
import { acknowledge, incidentStore, loadIncidents, markFixing } from './incidents.js';
import { buildScorecard, formatScorecard, parseSince } from './scorecard.js';
import { loadContext } from './load.js';
import { readEvents } from './incidents.js';
import { layoutFromEnv, scanOnce } from './run.js';
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

  test('parseSince accepts 24h and rejects a bare word', () => {
    expect(parseSince('24h', 0)).toBe(24 * 60 * 60 * 1000);
    expect(parseSince('30m', 0)).toBe(30 * 60 * 1000);
    expect(parseSince(undefined, 5)).toBe(5);
    expect(() => parseSince('tomorrow', 0)).toThrow(/--since/);
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
