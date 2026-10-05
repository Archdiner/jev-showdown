import * as os from 'os';
import * as path from 'path';
import { beat } from '../heartbeat.js';
import type { OpsPaths } from '../paths.js';
import { CHECKS } from './checks.js';
import { clockGames, splitHits } from './episodes.js';
import {
  countSeverity,
  incidentStore,
  loadIncidents,
  openP0,
  readEvents,
  reconcile,
  writeIncidents,
} from './incidents.js';
import { loadContext, type LoadOptions } from './load.js';
import { buildScorecard, formatScorecard, parseSince } from './scorecard.js';
import { DEFAULTS, type CheckHit, type InvariantCheck, type Layout, type SentinelContext } from './types.js';

export interface ScanResult {
  openP0: number;
  openP1: number;
  incidents: number;
  line: string;
  hits: Array<{ id: string; severity: string; key: string; detail: string }>;
}

export function collectHits(ctx: SentinelContext): Array<{ check: InvariantCheck; hit: CheckHit }> {
  const found: Array<{ check: InvariantCheck; hit: CheckHit }> = [];
  for (const check of CHECKS) {
    for (const hit of check.detect(ctx)) found.push({ check, hit });
  }
  return found;
}

export function scanOnce(
  layout: Layout,
  options: LoadOptions & { soakMs?: number; heartbeat?: boolean; since?: string; maxEventBytes?: number; episodePassGames?: number; episodePassMs?: number } = {},
): ScanResult {
  const now = options.now ?? Date.now();
  const baselineMs = options.baselineMs !== undefined
    ? options.baselineMs
    : options.since
      ? parseBaseline(options.since, now)
      : undefined;
  const ctx = loadContext(layout, { ...options, now, baselineMs });
  const store = incidentStore(layout.opsDir);
  const prior = loadIncidents(store);
  const hits = collectHits(ctx);
  const soakMs = options.soakMs ?? DEFAULTS.soakMs;
  const split = splitHits(hits, ctx.baselineMs);
  const { events, incidents } = reconcile(prior, {
    continuous: split.continuous,
    groups: split.groups,
    clock: {
      now: ctx.now,
      baselineMs: ctx.baselineMs,
      passGames: options.episodePassGames ?? DEFAULTS.episodePassGames,
      passMs: options.episodePassMs ?? DEFAULTS.episodePassMs,
      games: clockGames(ctx.games),
      runnerAlive: ctx.runs.some(run => !run.local && (ctx.processes.some(proc => proc.pid === run.pid) || ctx.pidAlive(run.pid))),
    },
  }, ctx.now, soakMs);
  writeIncidents(store, events, incidents, soakMs, ctx.now, options.maxEventBytes ?? DEFAULTS.maxEventBytes);
  if (options.heartbeat) {
    const paths = heartbeatPaths(layout.opsDir);
    beat(paths, 'sentinel', 'ok', `open P0=${openP0(incidents)} P1=${countSeverity(incidents, 'P1')}`);
  }
  const p0 = openP0(incidents);
  const p1 = countSeverity(incidents, 'P1');
  return {
    openP0: p0,
    openP1: p1,
    incidents: incidents.length,
    line: `sentinel open P0=${p0} P1=${p1} incidents=${incidents.length}`,
    hits: hits.map(item => ({
      id: item.check.id,
      severity: item.check.severity,
      key: item.hit.key,
      detail: item.hit.detail,
    })),
  };
}

/** Absolute cutoff. A duration is measured back from `now`. An ISO timestamp is that instant. */
export function parseBaseline(value: string, now: number): number {
  const trimmed = value.trim();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(trimmed);
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2];
    const scale = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    return now - amount * scale;
  }
  const absolute = Date.parse(trimmed);
  if (Number.isFinite(absolute)) return absolute;
  throw new Error(`--since must look like 24h, 7d, 30m, or an ISO timestamp (got ${value})`);
}

export async function runSentinel(
  layout: Layout,
  options: LoadOptions & {
    once?: boolean;
    json?: boolean;
    soakMs?: number;
    intervalMs?: number;
    since?: string;
    scans?: number;
    maxEventBytes?: number;
    episodePassGames?: number;
    episodePassMs?: number;
  } = {},
): Promise<number> {
  const scans = options.scans ?? (options.once ? 1 : Number.POSITIVE_INFINITY);
  let code = 0;
  for (let index = 0; index < scans; index++) {
    const now = options.now ?? Date.now();
    const result = scanOnce(layout, { ...options, heartbeat: true, now });
    if (options.json) {
      const incidents = loadIncidents(incidentStore(layout.opsDir));
      console.log(JSON.stringify({
        openP0: result.openP0,
        openP1: result.openP1,
        incidents: incidents.filter(item => item.status !== 'verified'),
      }));
    } else {
      console.log(result.line);
    }
    code = result.openP0 > 0 ? 1 : 0;
    if (index + 1 >= scans) return code;
    await new Promise(resolve => setTimeout(resolve, options.intervalMs ?? DEFAULTS.intervalMs));
  }
  return code;
}

export function renderScorecard(layout: Layout, options: LoadOptions & { since?: string; markdown?: boolean } = {}): string {
  const now = options.now ?? Date.now();
  const ctx = loadContext(layout, { ...options, now });
  const store = incidentStore(layout.opsDir);
  const sinceMs = parseSince(options.since, DEFAULTS.lookbackMs, now);
  const card = buildScorecard(ctx, loadIncidents(store), readEvents(store.eventsPath), sinceMs);
  return formatScorecard(card, options.markdown ? 'md' : 'text');
}

export function layoutFromEnv(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): Layout {
  const opsDir = env.OPS_DIR ? path.resolve(cwd, env.OPS_DIR) : path.join(cwd, 'state', 'ops');
  const graphDb = env.GRAPH_DB
    ? path.resolve(cwd, env.GRAPH_DB)
    : path.resolve(opsDir) === path.resolve(cwd, 'state', 'ops')
      ? path.join(cwd, 'state', 'graph.db')
      : path.join(opsDir, 'graph.db');
  return {
    cwd,
    liveRepoDir: env.LIVE_REPO_DIR ? expandHome(env.LIVE_REPO_DIR, cwd) : null,
    opsDir,
    ladderLogDir: env.LADDER_LOG_DIR ? path.resolve(cwd, env.LADDER_LOG_DIR) : path.join(cwd, 'logs', 'ladder'),
    liveRunsDir: env.LIVE_RUNS_DIR ? path.resolve(cwd, env.LIVE_RUNS_DIR) : path.join(cwd, 'live-runs'),
    dataDir: env.JEV_DATA_DIR ? path.resolve(cwd, env.JEV_DATA_DIR) : path.join(cwd, 'data'),
    graphDb,
  };
}

function expandHome(value: string, cwd: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(cwd, value);
}

function heartbeatPaths(root: string): OpsPaths {
  const file = (name: string) => path.join(root, name);
  return {
    root,
    graph: file('graph.db'),
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
