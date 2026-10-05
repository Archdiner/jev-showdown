import { isLocalLiveGame, recordedElo, recordedOutcome } from '../client/game-record.js';
import { openDb } from './db.js';
import { readJsonl, type OpsPaths } from './paths.js';
import { listJobs } from './queue.js';

interface LiveRow {
  ts: number;
  configId: string;
  winner?: string | null;
  outcome?: 'win' | 'loss' | 'tie';
  rating?: number | null;
  eloAfter?: number | null;
  localServer?: boolean;
  replayStatus?: string | null;
}

const DAY = 24 * 60 * 60 * 1000;

export function dailyReport(paths: OpsPaths, now = Date.now()): string {
  const games = readJsonl<LiveRow>(paths.liveGames).filter(game => game.ts >= now - DAY);
  const db = openDb(paths);
  let promotions: string[] = [];
  let regressions: string[] = [];
  try {
    promotions = db.getNodesByType('Decision').flatMap(node => {
      if (node.type !== 'Decision') return [];
      if (node.created_at < now - DAY) return [];
      if (node.decision !== 'champion' && node.decision !== 'live-approved') return [];
      return [`${node.decision}: ${node.description || node.title}`];
    });
    regressions = db.getNodesByType('Learning').flatMap(node => {
      if (node.type !== 'Learning') return [];
      const meta = node.metadata as { opsKind?: string } | undefined;
      if (meta?.opsKind !== 'regression' || node.status !== 'detected') return [];
      return [node.insight || node.title];
    });
  } finally {
    db.close();
  }

  const sentences: string[] = [];
  if (games.length === 0) {
    sentences.push('No live games were recorded in the last day.');
  } else {
    const ladderGames = games.filter(game => !isLocalLiveGame(game));
    const localCount = games.length - ladderGames.length;
    if (localCount > 0) {
      sentences.push(`${localCount} local ${localCount === 1 ? 'game is' : 'games are'} not a ladder rating.`);
    }
    const rated = ladderGames
      .map(game => recordedElo(game))
      .filter((value): value is number => value !== null);
    if (ladderGames.length === 0) {
      // Local games were already described. Do not invent a ladder move.
    } else if (rated.length === 0) {
      sentences.push(`No rating was reported across ${ladderGames.length} live games.`);
    } else {
      const first = rated[0];
      const last = rated[rated.length - 1];
      const direction = last > first ? 'up' : last < first ? 'down' : 'flat';
      sentences.push(`Rating moved ${direction} from ${first} to ${last} across ${ladderGames.length} live games.`);
    }
  }

  const ids = [...new Set(games.map(game => game.configId))];
  if (ids.length === 0) sentences.push('No per-config win rate yet.');
  for (const id of ids) {
    const rows = games.filter(game => game.configId === id);
    const wins = rows.filter(game => recordedOutcome(game) === 'win').length;
    const rate = rows.length ? Math.round((wins / rows.length) * 100) : 0;
    sentences.push(`${id} won ${rate}% of ${rows.length} games.`);
  }

  sentences.push(regressions.length ? `Open regressions: ${regressions.join('; ')}.` : 'No open regressions.');
  sentences.push(promotions.length ? `Promotions: ${promotions.join('; ')}.` : 'No promotions in the last day.');

  const next = listJobs(paths).filter(job => job.status === 'open' || job.status === 'in_progress');
  sentences.push(next.length
    ? `Next queue: ${next.map(job => job.spec.kind).join(', ')}.`
    : 'The factory queue is empty.');
  return sentences.join(' ');
}
