import { isLocalLiveGame, recordedElo, recordedOutcome } from '../client/game-record.js';
import { cycleLines, readCycle } from './cycle.js';
import { openDb } from './db.js';
import { latestHeartbeats } from './heartbeat.js';
import { readLabels } from './labels-read.js';
import { readJsonl, type OpsPaths } from './paths.js';
import { listJobs } from './queue.js';

interface LiveRow {
  ts: number;
  configId: string;
  winner?: string | null;
  outcome?: 'win' | 'loss' | 'tie';
  rating?: number | null;
  eloAfter?: number | null;
  gxe: number | null;
  localServer?: boolean;
  replayStatus?: string | null;
}

export function statusReport(paths: OpsPaths, now = Date.now()): string {
  const beats = latestHeartbeats(paths);
  const jobs = listJobs(paths);
  const queued = jobs.filter(job => job.status === 'open' || job.status === 'in_progress');
  const games = readJsonl<LiveRow>(paths.liveGames);
  const db = openDb(paths);
  let labels: ReturnType<typeof readLabels> = [];
  let regressions = 0;
  try {
    labels = readLabels(db);
    regressions = db.getNodesByType('Learning').filter(node => {
      const meta = node.metadata as { opsKind?: string } | undefined;
      return meta?.opsKind === 'regression' && node.status === 'detected';
    }).length;
  } finally {
    db.close();
  }

  const lines: string[] = [];
  lines.push('ops status');
  for (const name of ['factory', 'gatekeeper', 'live', 'analyst', 'sentinel'] as const) {
    const beat = beats[name];
    const age = beat ? `${Math.round((now - beat.ts) / 1000)}s` : 'never';
    const health = !beat ? 'down' : beat.status === 'error' ? 'error' : now - beat.ts > 60_000 && beat.status === 'ok' ? 'stale' : beat.status;
    lines.push(`  ${name.padEnd(12)} ${health.padEnd(8)} ${age.padEnd(8)} ${beat?.detail || ''}`);
  }
  lines.push(`queue ${queued.length}  (${queued.map(job => job.spec.kind).join(', ') || 'empty'})`);
  const lastLadder = [...games].reverse().find(game => !isLocalLiveGame(game) && recordedElo(game) !== null);
  const last = lastLadder ?? [...games].reverse().find(game => !isLocalLiveGame(game));
  const localOnly = games.length > 0 && games.every(game => isLocalLiveGame(game));
  lines.push(localOnly
    ? 'rating local  gxe local'
    : `rating ${last ? recordedElo(last) ?? 'n/a' : 'n/a'}  gxe ${last?.gxe ?? 'n/a'}`);
  const ids = new Set([...labels.map(label => label.configId), ...games.map(game => game.configId)]);
  if (ids.size === 0) lines.push('live record: none');
  for (const id of ids) {
    const rows = games.filter(game => game.configId === id);
    const wins = rows.filter(game => recordedOutcome(game) === 'win').length;
    const losses = rows.filter(game => recordedOutcome(game) === 'loss').length;
    const label = labels.find(item => item.configId === id);
    const lastLadderRow = [...rows].reverse().find(game => !isLocalLiveGame(game));
    const lastLocal = rows.some(game => isLocalLiveGame(game));
    const ratingText = lastLadderRow
      ? recordedElo(lastLadderRow) ?? 'n/a'
      : (lastLocal ? 'local' : 'n/a');
    lines.push(`  ${id} [${label?.labels.join('+') || 'unlabeled'}] ${wins}-${losses} rating ${ratingText}`);
  }
  lines.push(`open regressions ${regressions}`);
  lines.push(...cycleLines(readCycle(paths), now));
  return lines.join('\n');
}
