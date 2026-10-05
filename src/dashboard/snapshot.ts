import * as fs from 'fs';
import * as path from 'path';
import type { DashboardPaths } from './paths.js';
import { parseLog, parseSummary, runnerFromName, type GameRecord, type Heartbeat } from './parse.js';
import { reportGames, type GameReport } from './games.js';
import { sprt, wilson } from './stats.js';

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
    report: GameReport;
  };
  ops: {
    available: boolean;
    statusText: string;
    facilities: Array<{ name: string; health: string; ageMs: number | null; pid: number | null; detail: string }>;
  };
  runs: {
    logs: Array<{ path: string; runner: string; games: number; openBattles: string[] }>;
  };
  metrics: {
    variants: VariantRow[];
    regressions: { available: false; note: string };
  };
  agents: { available: false; path: string; note: string };
}

const FACILITIES = ['factory', 'gatekeeper', 'live', 'analyst', 'supervisor'] as const;
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

function dedupe(games: GameRecord[]): GameRecord[] {
  const seen = new Set<string>();
  return games.filter(game => {
    const key = game.battleId
      ? `id:${game.battleId}`
      : `line:${game.source}:${game.progress ?? ''}:${game.opponent ?? ''}:${game.outcome}:${game.turns ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

  const unique = dedupe(games);
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
  const statusText = [
    'ops status',
    ...facilities.map(facility => `  ${facility.name.padEnd(12)} ${facility.health.padEnd(14)} ${facility.ageMs === null ? 'never' : `${Math.round(facility.ageMs / 1000)}s`}`),
    `games ${record.wins}-${record.losses}-${record.ties}`,
    `rating ${latestElo ?? 'n/a'}`,
  ].join('\n');

  const ordered = orderedAll.slice(0, 200);
  const gameView = {
    record,
    elo: latestElo,
    gxe: latestGxe,
    recent: ordered,
    variants,
    report: reportGames(unique),
  };

  return {
    apiVersion: 1,
    generatedAt: now,
    fixtureMode: paths.fixtureMode,
    sources,
    gaps,
    games: gameView,
    ops: { available: fs.existsSync(heartbeatsPath) || fs.existsSync(liveGamesPath), statusText, facilities },
    runs: { logs },
    metrics: {
      variants,
      regressions: {
        available: false,
        note: 'Per-situation regressions are not loaded yet. Expected later: graph Regression nodes or state/ops/regression-suite.jsonl.',
      },
    },
    agents: {
      available: false,
      path: path.join(paths.cwd, 'state', 'cloud-agents.json'),
      note: 'Cloud agents and GitHub PRs are not loaded in this slice. Expected later: state/cloud-agents.json version 1 plus the GitHub pulls API.',
    },
  };
}
