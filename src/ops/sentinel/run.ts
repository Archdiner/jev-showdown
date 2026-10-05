import * as path from 'path';
import { beat } from '../heartbeat.js';
import type { OpsPaths } from '../paths.js';
import { CHECKS } from './checks.js';
import {
  countSeverity,
  foldIncidents,
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

export function scanOnce(layout: Layout, options: LoadOptions & { soakMs?: number; heartbeat?: boolean } = {}): ScanResult {
  const ctx = loadContext(layout, options);
  const store = incidentStore(layout.opsDir);
  const prior = loadIncidents(store);
  const hits = collectHits(ctx);
  const soakMs = options.soakMs ?? DEFAULTS.soakMs;
  const events = reconcile(prior, hits, ctx.now, soakMs);
  const incidents = foldIncidents([...readEvents(store.eventsPath), ...events]);
  writeIncidents(store, events, incidents, soakMs, ctx.now);
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

export async function runSentinel(
  layout: Layout,
  options: LoadOptions & { once?: boolean; json?: boolean; soakMs?: number; intervalMs?: number } = {},
): Promise<number> {
  let code = 0;
  do {
    const result = scanOnce(layout, { ...options, heartbeat: true, now: options.once ? options.now : Date.now() });
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
    if (options.once) return code;
    await new Promise(resolve => setTimeout(resolve, options.intervalMs ?? DEFAULTS.intervalMs));
  } while (!options.once);
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
    opsDir,
    ladderLogDir: env.LADDER_LOG_DIR ? path.resolve(cwd, env.LADDER_LOG_DIR) : path.join(cwd, 'logs', 'ladder'),
    liveRunsDir: env.LIVE_RUNS_DIR ? path.resolve(cwd, env.LIVE_RUNS_DIR) : path.join(cwd, 'live-runs'),
    dataDir: env.JEV_DATA_DIR ? path.resolve(cwd, env.JEV_DATA_DIR) : path.join(cwd, 'data'),
    graphDb,
  };
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
