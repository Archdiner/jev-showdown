import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { filterGames, ratingBand, reportGames } from './games.js';
import { resolvePaths } from './paths.js';
import { classifyLoss, normalizeEndReason, parseLadderLine, parseLog, type GameRecord } from './parse.js';
import { GraphDB } from '../graph/db.js';
import { startDashboard } from './server.js';
import { buildSnapshot } from './snapshot.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function game(partial: Partial<GameRecord> & Pick<GameRecord, 'outcome'>): GameRecord {
  const endReason = partial.endReason ?? null;
  return {
    ts: 0,
    battleId: null,
    opponent: null,
    opponentRating: null,
    ratingBefore: null,
    ratingAfter: null,
    elo: partial.ratingAfter ?? null,
    gxe: null,
    replayUrl: null,
    endReason,
    durationMs: null,
    turns: null,
    latency: null,
    minTimerSeconds: null,
    configId: null,
    configPath: null,
    configHash: null,
    engine: null,
    gitSha: null,
    runId: null,
    batchLabel: null,
    hostname: null,
    concurrency: null,
    runner: null,
    invalid: null,
    crashes: null,
    fallbacks: null,
    source: 'test',
    progress: null,
    ...partial,
    lossClass: partial.lossClass ?? classifyLoss(partial.outcome, partial.endReason ?? null),
  };
}

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

describe('game feed parsers', () => {
  it('parses a ladder line and leaves the end reason unknown', () => {
    const win = parseLadderLine(
      '[ladder] 2/30 win vs X turns=21 invalid=0 crashes=0 fallbacks=0 elo=1073',
      { source: 'search1.log', runner: 'jevsearch', engine: 'search', ts: 2 },
    );
    expect(win?.outcome).toBe('win');
    expect(win?.opponent).toBe('X');
    expect(win?.elo).toBe(1073);
    expect(win?.endReason).toBeNull();
    expect(win?.lossClass).toBe('not-a-loss');
    expect(win?.progress).toBe('2/30');
    const loss = parseLadderLine(
      '[ladder] 3/30 loss vs Y turns=18 invalid=0 crashes=0 fallbacks=1 elo=n/a',
      { source: 'search1.log', runner: 'jevsearch', engine: 'search', ts: 3 },
    );
    expect(loss?.elo).toBeNull();
    expect(loss?.lossClass).toBe('unclassified');
  });

  it('normalizes telemetry end reasons', () => {
    expect(normalizeEndReason('timer loss (ours)', 'loss')).toBe('timer-ours');
    expect(normalizeEndReason('timer theirs', 'win')).toBe('timer-theirs');
    expect(normalizeEndReason('timer', 'win')).toBe('timer-theirs');
    expect(normalizeEndReason('KO', 'loss')).toBe('ko');
    expect(normalizeEndReason('opponent forfeit', 'win')).toBe('opponent-forfeit');
    expect(normalizeEndReason('our forfeit', 'loss')).toBe('our-forfeit');
    expect(normalizeEndReason('forfeit', 'loss')).toBe('our-forfeit');
    expect(normalizeEndReason('disconnect', 'loss')).toBe('disconnect');
    expect(normalizeEndReason('crash', 'loss')).toBe('crash');
    expect(normalizeEndReason('ragequit', 'loss')).toBeNull();
  });

  it('parses a rich game record and falls back when the line is not JSON', () => {
    const parsed = parseLog([
      '{"type":"game","ts":4000,"id":"battle-rich-1","replayUrl":"https://replay.pokemonshowdown.com/gen9randombattle-900","outcome":"loss","opponent":"ace","opponentRating":1410,"ratingBefore":1200,"ratingAfter":1184,"endReason":"timer loss (ours)","durationMs":240000,"latency":{"p50":180,"p95":900,"max":1500},"minTimerSeconds":1,"engine":"search","configId":"champion","configHash":"abc","gitSha":"87b268f","concurrency":2}',
      '{"kind":"live-game","id":"battle-1","ts":2000,"configId":"champion-hash","winner":"win","rating":1204,"gxe":62.5}',
      '{not json',
      '[ladder] 2/30 win vs X turns=21 invalid=0 crashes=0 fallbacks=0 elo=1073',
    ].join('\n'), { source: 'mixed.log', runner: 'jevsearch' });
    expect(parsed.skipped).toBe(1);
    expect(parsed.games).toHaveLength(3);
    const rich = parsed.games[0];
    expect(rich.endReason).toBe('timer-ours');
    expect(rich.lossClass).toBe('timer-disconnect');
    expect(rich.opponentRating).toBe(1410);
    expect(rich.ratingBefore).toBe(1200);
    expect(rich.ratingAfter).toBe(1184);
    expect(rich.replayUrl).toBe('https://replay.pokemonshowdown.com/gen9randombattle-900');
    expect(rich.latency).toEqual({ p50: 180, p95: 900, p99: null, max: 1500 });
    expect(rich.configHash).toBe('abc');
    expect(rich.gitSha).toBe('87b268f');
    expect(rich.concurrency).toBe(2);
    const stamped = parseLog([
      '{"kind":"ladder-game","battleId":"battle-a","outcome":"win","runId":"run-a","batchLabel":"batch-9","hostname":"live-mac","eloAfter":1100}',
      '{"kind":"ladder-game","battleId":"battle-b","outcome":"loss","runId":"run-a","eloAfter":1080}',
      '{"kind":"ladder-game","battleId":"battle-c","outcome":"win","runId":"run-b","hostname":"other"}',
    ].join('\n'), { source: 'games.jsonl', runner: 'ladder' });
    expect(stamped.games.map(row => row.runId)).toEqual(['run-a', 'run-a', 'run-b']);
    expect(stamped.games[0].batchLabel).toBe('batch-9');
    expect(stamped.games[0].hostname).toBe('live-mac');
    expect(parsed.games[1].configId).toBe('champion-hash');
    expect(parsed.games[1].gxe).toBe(62.5);
    expect(parsed.games[2].endReason).toBeNull();
    expect(parsed.games[2].elo).toBe(1073);
    const hidden = parseLog([
      '{"type":"result","kind":"ladder-game","battleId":"ghost","turns":0,"outcome":"tie","endReason":"disconnect","winner":null,"eloAfter":1185}',
      '{"kind":"ladder-game","turns":8,"outcome":"loss","endReason":"ko","eloAfter":1074,"localServer":true,"replayStatus":"local-only"}',
      '{"kind":"ladder-game","turns":8,"outcome":"win","endReason":"ko","eloAfter":1185}',
    ].join('\n'), { source: 'games.jsonl', runner: 'ladder' });
    expect(hidden.games).toHaveLength(2);
    expect(hidden.games[0].elo).toBeNull();
    expect(hidden.games[1].elo).toBe(1185);
  });

  it('keeps timer and disconnect losses out of the strategy rate', () => {
    const ko = game({ outcome: 'loss', endReason: 'ko' });
    const timer = game({ outcome: 'loss', endReason: 'timer-ours' });
    const win = game({ outcome: 'win', endReason: 'ko', opponentRating: 1410 });
    const report = reportGames([ko, timer, win]);
    expect(report.strategy).toMatchObject({ wins: 1, losses: 1 });
    expect(report.timerDisconnect).toMatchObject({ wins: 0, losses: 1 });
    expect(report.strategyLosses).toBe(1);
    expect(report.timerDisconnectLosses).toBe(1);
    expect(report.strategy.winRate).not.toBeNull();
    expect(filterGames([ko, timer, win], { endReason: 'timer-ours', band: 'any' })).toEqual([timer]);
    expect(filterGames([ko, timer, win], { endReason: 'any', band: '1400-1599' })).toEqual([win]);
    expect(ratingBand(1100)).toBe('under-1200');
    expect(ratingBand(1650)).toBe('1600-plus');
    expect(ratingBand(null)).toBe('unknown');
  });

  it('builds a snapshot from the fixtures', () => {
    const paths = resolvePaths({ DASHBOARD_FIXTURE_DIR: fixtureDir }, process.cwd());
    const snapshot = buildSnapshot(paths, 10_000);
    const ids = snapshot.games.recent.map(row => row.battleId);
    expect(ids).toContain('battle-rich-1');
    expect(ids).toContain('battle-gen9randombattle-9');
    expect(ids).toContain('battle-1');
    const merged = snapshot.games.recent.find(row => row.battleId === 'battle-gen9randombattle-9');
    expect(merged?.opponent).toBe('ace');
    expect(merged?.latency).toEqual({ p50: 80, p95: 120, p99: 200, max: null });
    expect(merged?.minTimerSeconds).toBe(12);
    expect(merged?.runId).toBe('run-1');
    expect(snapshot.games.byRun.some(run => run.runId === 'run-1' && run.games >= 1)).toBe(true);
    expect(snapshot.games.recent.filter(row => row.battleId === 'battle-gen9randombattle-9')).toHaveLength(1);
    expect(snapshot.ops.reportText).toMatch(/graph\.db/);
    const rich = snapshot.games.recent.find(row => row.battleId === 'battle-rich-1');
    expect(rich?.replayUrl).toContain('gen9randombattle-900');
    expect(rich?.lossClass).toBe('timer-disconnect');
    const ladder = snapshot.games.recent.find(row => row.opponent === 'X');
    expect(ladder?.endReason).toBeNull();
    expect(ladder?.elo).toBe(1073);
    expect(snapshot.games.elo).toBe(1190);
    expect(snapshot.games.report.timerDisconnectLosses).toBe(1);
    expect(snapshot.games.report.strategyLosses).toBe(1);
    expect(snapshot.ops.facilities.find(row => row.name === 'supervisor')?.health).toBe('down');
    expect(snapshot.ops.facilities.find(row => row.name === 'live')?.health).toBe('ok');
    expect(snapshot.gaps.some(gap => gap.id === 'malformed')).toBe(true);
    expect(snapshot.runs.logs.some(log => log.openBattles.length > 0)).toBe(false);
  });

  it('uses ops status and the daily report when graph.db exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-ops-'));
    const now = 1_700_000_000_000;
    const ops = path.join(dir, 'ops');
    fs.mkdirSync(ops);
    fs.mkdirSync(path.join(dir, 'ladder'));
    fs.mkdirSync(path.join(dir, 'search'));
    fs.writeFileSync(path.join(ops, 'heartbeats.jsonl'), `${JSON.stringify({ facility: 'live', pid: 1, ts: now, status: 'ok', detail: 'up' })}\n`);
    fs.writeFileSync(path.join(ops, 'live-games.jsonl'), `${JSON.stringify({ kind: 'live-game', id: 'b', ts: now, configId: 'champion', winner: 'win', rating: 1200, gxe: 55 })}\n`);
    const graph = path.join(dir, 'graph.db');
    new GraphDB(graph).close();
    const paths = resolvePaths({
      OPS_DIR: ops,
      GRAPH_DB: graph,
      LADDER_LOG_DIR: path.join(dir, 'ladder'),
      SEARCH_LOG_DIR: path.join(dir, 'search'),
    }, dir);
    const snapshot = buildSnapshot(paths, now);
    expect(snapshot.ops.statusText).toContain('queue 0');
    expect(snapshot.ops.statusText).toContain('champion');
    expect(snapshot.ops.statusText).toContain('open regressions 0');
    expect(snapshot.ops.reportText).toContain('Rating moved flat from 1200 to 1200 across 1 live games.');
    expect(snapshot.ops.reportText).toContain('The factory queue is empty.');
  });

  it('reports missing sources on an empty directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));
    const paths = resolvePaths({ DASHBOARD_FIXTURE_DIR: dir }, process.cwd());
    const snapshot = buildSnapshot(paths, 10_000);
    expect(snapshot.gaps.map(gap => gap.id)).toEqual(expect.arrayContaining(['heartbeats', 'live-games', 'ladder-logs', 'search-logs']));
    expect(snapshot.games.recent).toEqual([]);
  });

  it('serves the feed and the filtered games API', async () => {
    const paths = resolvePaths({
      DASHBOARD_FIXTURE_DIR: fixtureDir,
      DASHBOARD_PORT: '0',
      DASHBOARD_HOST: '127.0.0.1',
    }, process.cwd());
    const server = await startDashboard(paths);
    try {
      const page = await get(`${server.url}/`);
      expect(page.status).toBe(200);
      expect(page.body).toContain('End reason');
      expect(page.body).toContain('>Run</th>');
      const games = await get(`${server.url}/api/games?endReason=timer-ours&band=1400-1599`);
      expect(games.status).toBe(200);
      const payload = JSON.parse(games.body);
      expect(payload.games.byRun.some((run: { runId: string }) => run.runId === 'run-1')).toBe(true);
      expect(payload.games.filtered).toHaveLength(1);
      expect(payload.games.filtered[0].battleId).toBe('battle-rich-1');
      expect(payload.games.filteredReport.timerDisconnectLosses).toBe(1);
      expect(payload.games.filteredReport.strategyLosses).toBe(0);
      const metrics = await get(`${server.url}/api/metrics?endReason=strategy`);
      const metricsBody = JSON.parse(metrics.body);
      expect(metricsBody.metrics.report.strategyLosses).toBeGreaterThan(0);
      expect((await get(`${server.url}/api/status`)).status).toBe(200);
      expect((await get(`${server.url}/api/runs`)).status).toBe(200);
      expect((await get(`${server.url}/api/agents`)).status).toBe(200);
      expect((await get(`${server.url}/api/snapshot`)).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
