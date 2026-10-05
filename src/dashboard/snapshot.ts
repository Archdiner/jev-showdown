import * as fs from 'fs';
import * as path from 'path';
import { compareIncidents, incidentStore, loadIncidents, readEvents } from '../ops/sentinel/incidents.js';
import { loadContext } from '../ops/sentinel/load.js';
import { buildScorecard, formatScorecard } from '../ops/sentinel/scorecard.js';
import type { OpsPaths } from '../ops/paths.js';
import { dailyReport } from '../ops/report.js';
import { statusReport } from '../ops/status.js';
import type { DashboardPaths } from './paths.js';
import { groupByRunId } from '../client/game-record.js';
import { classifyLoss, parseLog, parseSummary, runnerFromName, type GameRecord, type Heartbeat, type LatencySummary } from './parse.js';
import { configPanels, reportGames, type ConfigPanel, type GameReport } from './games.js';
import { sprt, wilson } from './stats.js';
import {
  type CalibrationSample,
  type CalibrationSummary,
  combineCalibrations,
  dedupeSamples,
  summarizeSamples,
} from '../client/prediction.js';

export interface Gap {
  id: string;
  status: 'missing' | 'stale';
  source: string;
  path: string;
  reason: string;
  matters: string;
}

export interface VariantRow {
  id: string;
  wins: number;
  losses: number;
  ties: number;
  games: number;
  winRate: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  elo: number | null;
  gxe: number | null;
  sprt: string;
}

export interface Snapshot {
  apiVersion: 1;
  generatedAt: number;
  fixtureMode: boolean;
  sources: Array<{ id: string; path: string; available: boolean; note: string }>;
  gaps: Gap[];
  games: {
    record: { wins: number; losses: number; ties: number; games: number };
    elo: number | null;
    gxe: number | null;
    recent: GameRecord[];
    variants: VariantRow[];
    byRun: ReturnType<typeof groupByRunId>;
    report: GameReport;
    configs: ConfigPanel[];
  };
  ops: {
    available: boolean;
    statusText: string;
    reportText: string;
    facilities: Array<{ name: string; health: string; ageMs: number | null; pid: number | null; detail: string }>;
  };
  runs: {
    logs: Array<{ path: string; runner: string; games: number; openBattles: string[] }>;
  };
  metrics: {
    variants: VariantRow[];
    regressions: { available: boolean; note: string };
  };
  /** Sim-versus-protocol totals across every logged turn, not only the recent table. */
  calibration: CalibrationSummary | null;
  agents: { available: false; path: string; note: string };
  reliability: {
    scorecard: string;
    incidents: Array<{
      id: string;
      checkId: string;
      severity: string;
      status: string;
      count: number;
      title: string;
      detail: string;
      firstSeen: number;
      lastSeen: number;
      pr: string | null;
      rootCause: string | null;
    }>;
  };
}

const FACILITIES = ['factory', 'gatekeeper', 'live', 'analyst', 'supervisor', 'sentinel'] as const;
const STALE_MS = 60_000;
const TAIL = 2_000_000;

function readTail(file: string): string {
  const stat = fs.statSync(file);
  const fd = fs.openSync(file, 'r');
  try {
    const length = Math.min(stat.size, TAIL);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (/\.(jsonl|log|txt|json)$/i.test(entry.name)) out.push(full);
    }
  };
  visit(dir);
  return out.sort();
}

function pick<T>(left: T | null, right: T | null): T | null {
  return left !== null ? left : right;
}

function richness(game: GameRecord): number {
  return (game.opponent ? 4 : 0)
    + (game.replayUrl ? 2 : 0)
    + (game.ratingAfter !== null ? 2 : 0)
    + (game.endReason ? 2 : 0)
    + (game.latency ? 1 : 0)
    + (game.minTimerSeconds !== null ? 1 : 0);
}

function mergeLatency(left: LatencySummary | null, right: LatencySummary | null): LatencySummary | null {
  if (!left) return right;
  if (!right) return left;
  return {
    p50: pick(left.p50, right.p50),
    p95: pick(left.p95, right.p95),
    p99: pick(left.p99, right.p99),
    max: pick(left.max, right.max),
  };
}

/** One row per battle. A metrics.jsonl `game` line fills latency onto the ladder result with the same id. */
function dedupe(games: GameRecord[]): GameRecord[] {
  const byId = new Map<string, GameRecord>();
  const lines: GameRecord[] = [];
  const seenLines = new Set<string>();
  for (const game of games) {
    if (game.battleId) {
      const prev = byId.get(game.battleId);
      byId.set(game.battleId, prev ? combine(prev, game) : game);
      continue;
    }
    const key = `${game.source}:${game.progress ?? ''}:${game.opponent ?? ''}:${game.outcome}:${game.turns ?? ''}`;
    if (seenLines.has(key)) continue;
    seenLines.add(key);
    lines.push(game);
  }
  return [...byId.values(), ...lines];
}

function combine(a: GameRecord, b: GameRecord): GameRecord {
  const primary = richness(a) >= richness(b) ? a : b;
  const other = primary === a ? b : a;
  const endReason = pick(primary.endReason, other.endReason);
  const outcome = primary.outcome;
  return {
    ...primary,
    ts: Math.max(a.ts, b.ts),
    outcome,
    opponent: pick(primary.opponent, other.opponent),
    opponentRating: pick(primary.opponentRating, other.opponentRating),
    ratingBefore: pick(primary.ratingBefore, other.ratingBefore),
    ratingAfter: pick(primary.ratingAfter, other.ratingAfter),
    elo: pick(primary.elo, other.elo),
    gxe: pick(primary.gxe, other.gxe),
    replayUrl: pick(primary.replayUrl, other.replayUrl),
    endReason,
    lossClass: classifyLoss(outcome, endReason),
    durationMs: pick(primary.durationMs, other.durationMs),
    turns: pick(primary.turns, other.turns),
    latency: mergeLatency(primary.latency, other.latency),
    minTimerSeconds: pick(primary.minTimerSeconds, other.minTimerSeconds),
    configId: pick(primary.configId, other.configId),
    configPath: pick(primary.configPath, other.configPath),
    configHash: pick(primary.configHash, other.configHash),
    role: primary.role ?? other.role,
    share: primary.share !== null ? primary.share : other.share,
    engine: pick(primary.engine, other.engine),
    gitSha: pick(primary.gitSha, other.gitSha),
    runId: pick(primary.runId, other.runId),
    batchLabel: pick(primary.batchLabel, other.batchLabel),
    hostname: pick(primary.hostname, other.hostname),
    concurrency: pick(primary.concurrency, other.concurrency),
    invalid: pick(primary.invalid, other.invalid),
    crashes: pick(primary.crashes, other.crashes),
    fallbacks: pick(primary.fallbacks, other.fallbacks),
    calibration: preferCalibration(primary.calibration, other.calibration),
  };
}

function preferCalibration(left: CalibrationSummary | null, right: CalibrationSummary | null): CalibrationSummary | null {
  if (!left) return right;
  if (!right) return left;
  return left.compared >= right.compared ? left : right;
}

function opsBundle(root: string, graph: string): OpsPaths {
  return {
    root,
    graph,
    heartbeats: path.join(root, 'heartbeats.jsonl'),
    liveGames: path.join(root, 'live-games.jsonl'),
    circuits: path.join(root, 'circuits.json'),
    analystOffset: path.join(root, 'analyst.offset'),
    analystFiles: path.join(root, 'analyst-files.json'),
    seenGames: path.join(root, 'analyst-seen.json'),
    regressionSuite: path.join(root, 'regression-suite.jsonl'),
    priors: path.join(root, 'behavior.json'),
    pool: path.join(root, 'mined-pool.json'),
    variants: path.join(root, 'variants.json'),
    cycle: path.join(root, 'cycle.jsonl'),
    dispositions: path.join(root, 'dispositions.jsonl'),
    hypotheses: path.join(root, 'hypotheses.json'),
  };
}

function variantsOf(games: GameRecord[]): VariantRow[] {
  const groups = new Map<string, GameRecord[]>();
  for (const game of games) {
    const id = game.configId || game.engine || game.runner || 'unknown';
    const rows = groups.get(id) ?? [];
    rows.push(game);
    groups.set(id, rows);
  }
  return [...groups.entries()].map(([id, rows]) => {
    const wins = rows.filter(game => game.outcome === 'win').length;
    const losses = rows.filter(game => game.outcome === 'loss').length;
    const ties = rows.filter(game => game.outcome === 'tie').length;
    const decided = wins + losses;
    const interval = wilson(wins, decided > 0 ? decided : rows.length);
    return {
      id,
      wins,
      losses,
      ties,
      games: rows.length,
      winRate: interval.rate,
      ciLow: interval.low,
      ciHigh: interval.high,
      elo: [...rows].reverse().find(game => game.elo !== null)?.elo ?? null,
      gxe: [...rows].reverse().find(game => game.gxe !== null)?.gxe ?? null,
      sprt: sprt(wins, losses),
    };
  });
}

export function buildSnapshot(paths: DashboardPaths, now = Date.now()): Snapshot {
  const games: GameRecord[] = [];
  const beats: Heartbeat[] = [];
  const scores: CalibrationSample[] = [];
  const logs: Snapshot['runs']['logs'] = [];
  const sources: Snapshot['sources'] = [];
  const gaps: Gap[] = [];
  let skipped = 0;

  const take = (file: string, runner: string | null) => {
    if (file.endsWith('summary.json')) {
      try {
        const parsed = parseSummary(JSON.parse(readTail(file)), file);
        games.push(...parsed);
        logs.push({ path: file, runner: runner || 'ladder', games: parsed.length, openBattles: [] });
      } catch {
        skipped += 1;
      }
      return;
    }
    const parsed = parseLog(readTail(file), { source: file, runner });
    skipped += parsed.skipped;
    games.push(...parsed.games);
    beats.push(...parsed.heartbeats);
    scores.push(...parsed.scores);
    logs.push({ path: file, runner: runner || 'log', games: parsed.games.length, openBattles: parsed.openBattles });
  };

  const heartbeatsPath = path.join(paths.opsDir, 'heartbeats.jsonl');
  const liveGamesPath = path.join(paths.opsDir, 'live-games.jsonl');
  if (fs.existsSync(heartbeatsPath)) {
    take(heartbeatsPath, null);
    sources.push({ id: 'heartbeats', path: heartbeatsPath, available: true, note: 'ops facility beats' });
  } else {
    sources.push({ id: 'heartbeats', path: heartbeatsPath, available: false, note: 'not available' });
    gaps.push({
      id: 'heartbeats',
      status: 'missing',
      source: 'ops heartbeats',
      path: heartbeatsPath,
      reason: 'heartbeats.jsonl is missing. ops factory, gatekeeper, live, and analyst write one JSON object per beat.',
      matters: 'Without it the dashboard cannot tell which facilities are up.',
    });
  }
  if (fs.existsSync(liveGamesPath)) {
    take(liveGamesPath, 'ops-live');
    sources.push({ id: 'live-games', path: liveGamesPath, available: true, note: 'ops live JSONL' });
  } else {
    sources.push({ id: 'live-games', path: liveGamesPath, available: false, note: 'not available' });
    gaps.push({
      id: 'live-games',
      status: 'missing',
      source: 'ops live games',
      path: liveGamesPath,
      reason: 'live-games.jsonl is missing. ops live appends one record per finished game.',
      matters: 'Per-config win/loss, rating, and GXE from the ladder login are invisible.',
    });
  }

  const ladderFiles = listFiles(paths.ladderLogDir);
  if (ladderFiles.length === 0) {
    sources.push({ id: 'ladder', path: paths.ladderLogDir, available: false, note: 'not available' });
    gaps.push({
      id: 'ladder-logs',
      status: 'missing',
      source: 'ladder logs',
      path: paths.ladderLogDir,
      reason: 'No logs/ladder JSONL or summary.json.',
      matters: 'Per-battle results, replay URLs, and Elo from the ladder client are missing.',
    });
  } else {
    for (const file of ladderFiles) take(file, 'ladder');
    sources.push({ id: 'ladder', path: paths.ladderLogDir, available: true, note: `${ladderFiles.length} files` });
  }

  const searchFiles = listFiles(paths.searchLogDir);
  if (searchFiles.length === 0) {
    sources.push({ id: 'search', path: paths.searchLogDir, available: false, note: 'not available' });
    gaps.push({
      id: 'search-logs',
      status: 'missing',
      source: 'live-run logs',
      path: paths.searchLogDir,
      reason: 'The live-runs directory is missing. Default is ~/jev-search/live-runs.',
      matters: 'Screen logs such as search1.log and the [ladder] N/M result lines are not visible.',
    });
  } else {
    for (const file of searchFiles) take(file, runnerFromName(path.basename(file)));
    sources.push({ id: 'search', path: paths.searchLogDir, available: true, note: `${searchFiles.length} files` });
  }

  if (skipped > 0) {
    gaps.push({
      id: 'malformed',
      status: 'missing',
      source: 'JSONL',
      path: paths.ladderLogDir,
      reason: `${skipped} JSONL line(s) were not valid JSON and were skipped.`,
      matters: 'Those games are missing from the record and the win rate.',
    });
  }

  if (paths.fixtureMode) {
    const newest = Math.max(0, ...games.map(game => game.ts), ...beats.map(beat => beat.ts));
    const shift = now - newest;
    if (Number.isFinite(shift) && shift !== 0) {
      for (const game of games) game.ts += shift;
      for (const beat of beats) beat.ts += shift;
    }
  }

  const latest = new Map<string, Heartbeat>();
  for (const beat of beats) latest.set(beat.facility, beat);
  const facilities = FACILITIES.map(name => {
    const beat = latest.get(name);
    if (!beat) return { name, health: fs.existsSync(heartbeatsPath) ? 'down' : 'not available', ageMs: null, pid: null, detail: 'no heartbeat' };
    const ageMs = now - beat.ts;
    const stale = beat.status === 'ok' && ageMs > STALE_MS;
    if (stale) {
      gaps.push({
        id: `stale-${name}`,
        status: 'stale',
        source: `${name} heartbeat`,
        path: heartbeatsPath,
        reason: `Last ${name} beat is ${Math.round(ageMs / 1000)}s old.`,
        matters: 'A facility that stops heartbeating can be wedged. Do not treat its last line as current.',
      });
    }
    const health = beat.status === 'error' ? 'error' : beat.status === 'stopped' ? 'stopped' : stale ? 'stale' : 'ok';
    return { name, health, ageMs, pid: beat.pid, detail: beat.detail };
  });

  const rolled = rollScores(dedupeSamples(scores));
  const unique = dedupe(games);
  for (const game of unique) {
    if (!game.battleId) continue;
    const fromTurns = rolled.get(game.battleId);
    if (!fromTurns) continue;
    // A finished game row is the full total. A log tail can hold only the latest turns.
    if (!game.calibration || fromTurns.compared > game.calibration.compared) game.calibration = fromTurns;
  }
  const calibration = calibrationOf(unique, rolled);
  const variants = variantsOf(unique);
  const orderedAll = [...unique].sort((a, b) => b.ts - a.ts);
  const record = {
    wins: unique.filter(game => game.outcome === 'win').length,
    losses: unique.filter(game => game.outcome === 'loss').length,
    ties: unique.filter(game => game.outcome === 'tie').length,
    games: unique.length,
  };
  const latestElo = orderedAll.find(game => game.elo !== null)?.elo ?? null;
  const latestGxe = orderedAll.find(game => game.gxe !== null)?.gxe ?? null;
  let statusText = [
    'ops status',
    ...facilities.map(facility => `  ${facility.name.padEnd(12)} ${facility.health.padEnd(14)} ${facility.ageMs === null ? 'never' : `${Math.round(facility.ageMs / 1000)}s`}`),
    `games ${record.wins}-${record.losses}-${record.ties}`,
    `rating ${latestElo ?? 'n/a'}`,
  ].join('\n');
  let reportText = 'Daily ops report needs state/graph.db, the same database npm run ops -- report reads. Heartbeats and live-games.jsonl are still shown above.';
  const graphReady = fs.existsSync(paths.graphDb);
  if (graphReady) {
    try {
      const bundle = opsBundle(paths.opsDir, paths.graphDb);
      statusText = statusReport(bundle, now);
      reportText = dailyReport(bundle, now);
    } catch (error) {
      reportText = `ops status failed: ${error instanceof Error ? error.message : 'unknown error'}`;
    }
  }

  const ordered = orderedAll.slice(0, 200);
  const gameView = {
    record,
    elo: latestElo,
    gxe: latestGxe,
    recent: ordered,
    variants,
    byRun: groupByRunId(unique),
    report: reportGames(unique),
    configs: configPanels(unique),
  };

  const reliability = reliabilityView(paths, now);
  return {
    apiVersion: 1,
    generatedAt: now,
    fixtureMode: paths.fixtureMode,
    sources,
    gaps,
    games: gameView,
    ops: { available: fs.existsSync(heartbeatsPath) || fs.existsSync(liveGamesPath) || graphReady, statusText, reportText, facilities },
    reliability,
    runs: { logs },
    metrics: {
      variants,
      regressions: {
        available: graphReady,
        note: graphReady
          ? 'Open regressions are the count in ops status, from Learning nodes with opsKind regression.'
          : 'Per-situation regressions need state/graph.db. ops status counts Learning nodes with opsKind regression.',
      },
    },
    agents: {
      available: false,
      path: path.join(paths.cwd, 'state', 'cloud-agents.json'),
      note: 'Cloud agents and GitHub PRs are not loaded in this slice. Expected later: state/cloud-agents.json version 1 plus the GitHub pulls API.',
    },
    calibration,
  };
}

function rollScores(samples: CalibrationSample[]): Map<string, CalibrationSummary> {
  const groups = new Map<string, CalibrationSample[]>();
  for (const sample of samples) {
    if (!sample.battleId) continue;
    const rows = groups.get(sample.battleId) ?? [];
    rows.push(sample);
    groups.set(sample.battleId, rows);
  }
  const out = new Map<string, CalibrationSummary>();
  for (const [battleId, rows] of groups) {
    const summary = summarizeSamples(rows);
    if (summary) out.set(battleId, summary);
  }
  return out;
}

/** One total per battle. Turn rows fill games that never wrote `calibration`. Orphan turn rows still count. */
function calibrationOf(games: GameRecord[], byBattle: Map<string, CalibrationSummary>): CalibrationSummary | null {
  const seen = new Set<string>();
  const parts: CalibrationSummary[] = [];
  for (const game of games) {
    if (game.battleId) seen.add(game.battleId);
    if (game.calibration) parts.push(game.calibration);
  }
  for (const [battleId, summary] of byBattle) {
    if (seen.has(battleId)) continue;
    parts.push(summary);
  }
  return combineCalibrations(parts);
}

function reliabilityView(paths: DashboardPaths, now: number): Snapshot['reliability'] {
  try {
    const ctx = loadContext({
      cwd: paths.cwd,
      opsDir: paths.opsDir,
      ladderLogDir: paths.ladderLogDir,
      liveRunsDir: paths.searchLogDir,
      dataDir: path.join(paths.cwd, 'data'),
      graphDb: paths.graphDb,
    }, {
      now,
      scanProcesses: false,
      git: { behind: null, ref: 'origin/main', detail: 'not scanned by the dashboard' },
    });
    const store = incidentStore(paths.opsDir);
    const incidents = loadIncidents(store)
      .filter(incident => incident.status !== 'verified')
      .sort(compareIncidents)
      .map(incident => ({
        id: incident.id,
        checkId: incident.checkId,
        severity: incident.severity,
        status: incident.status,
        count: incident.count,
        title: incident.title,
        detail: incident.detail,
        firstSeen: incident.firstSeen,
        lastSeen: incident.lastSeen,
        pr: incident.pr,
        rootCause: incident.rootCause,
      }));
    const events = fs.existsSync(store.eventsPath) ? readEvents(store.eventsPath) : [];
    return { scorecard: formatScorecard(buildScorecard(ctx, loadIncidents(store), events, 24 * 60 * 60 * 1000)), incidents };
  } catch (err) {
    return {
      scorecard: err instanceof Error ? err.message : 'scorecard failed',
      incidents: [],
    };
  }
}
