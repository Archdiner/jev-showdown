import * as fs from 'fs';
import { battleFromInputLog } from '../config/adapters.js';
import type { PositionRecord } from '../config/interfaces.js';
import { minePosition } from '../config/positions.js';
import { generalizeFinding } from '../exp/analyst.js';
import { GatewayClient } from '../llm/gateway-client.js';
import { LossReviewer, writeFindingAsHypothesis, type LossFinding } from '../llm/loss-reviewer.js';
import { openDb } from './db.js';
import { beat } from './heartbeat.js';
import { defaultAnalystDirs, gameFromRow, listGameJsonl, type AnalystGame } from './ingest.js';
import { appendJsonl, consumeJsonl, type OpsPaths } from './paths.js';
import { observeLog, readCounts, scrapeReplay, writePriors } from './priors.js';
import { enqueue } from './queue.js';

export async function runAnalyst(
  paths: OpsPaths,
  opts: { once?: boolean; replay?: string; ladderDirs?: string[] } = {},
): Promise<number> {
  beat(paths, 'analyst', 'ok', 'up');
  if (opts.replay) {
    const log = await scrapeReplay(opts.replay);
    const counts = readCounts(paths);
    observeLog(log, counts, 'each');
    writePriors(paths, counts);
  }
  const ladderDirs = opts.ladderDirs ?? defaultAnalystDirs();
  let reviewed = 0;
  do {
    const batch = unreadGames(paths, ladderDirs);
    if (batch.corrupt > 0) beat(paths, 'analyst', 'error', `log-corrupt ${batch.corrupt}`);
    const seenIds = new Set(readSeen(paths));
    for (const game of batch.games) {
      if (!game.id || seenIds.has(game.id)) continue;
      seenIds.add(game.id);
      await reviewGame(paths, game);
      markSeen(paths, game.id);
      reviewed += 1;
    }
    writeOffset(paths, batch.liveNext);
    writeFileOffsets(paths, batch.files);
    beat(paths, 'analyst', 'ok', `reviewed ${reviewed}`);
    if (opts.once) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  } while (!opts.once);
  beat(paths, 'analyst', 'stopped', 'exit');
  return reviewed;
}

async function reviewGame(paths: OpsPaths, game: AnalystGame): Promise<void> {
  if (game.foeSide) {
    const counts = readCounts(paths);
    observeLog(game.log || '', counts, game.foeSide);
    writePriors(paths, counts);
  }
  if (game.outcome !== 'loss') return;

  const mined = mineCritical(paths, game);
  const calcText = mined
    ? `depth ${mined.labelDepth} exact search label: ${mined.label}`
    : 'No reconstructed battle, so there is no calc block.';
  const finding = await reviewLoss(paths, game, calcText);
  const db = openDb(paths);
  try {
    writeFindingAsHypothesis(db, generalizeFinding(finding), {
      model: process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_AI_GATEWAY_KEY ? 'xai/grok-4.7' : 'local-fallback',
      battleId: game.id,
      sourcePath: game.sourcePath,
    });
  } finally {
    db.close();
  }
  if (mined) {
    enqueue(paths, {
      kind: 'position-replay',
      positionId: mined.id,
      labelDepth: mined.labelDepth,
    });
  }
}

function mineCritical(paths: OpsPaths, game: AnalystGame): PositionRecord | null {
  const inputLog = game.inputLog.includes('>start') ? game.inputLog : '';
  if (!inputLog || !game.ourSide) return null;
  try {
    const battle = battleFromInputLog(inputLog);
    const mined = minePosition({ battle, side: game.ourSide, seed: 1, labelDepth: 2, outPath: paths.pool });
    appendJsonl(paths.regressionSuite, mined);
    return mined;
  } catch {
    return null;
  }
}

async function reviewLoss(paths: OpsPaths, game: AnalystGame, calcText: string): Promise<LossFinding> {
  if (process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_AI_GATEWAY_KEY) {
    const reviewer = new LossReviewer(new GatewayClient());
    const result = await reviewer.review(game.log || '', {
      calcText,
      battleId: game.id,
      sourcePath: game.sourcePath,
    });
    if (result.ok && result.finding) return result.finding;
  }
  return {
    criticalTurn: 0,
    mistakeClass: 'other',
    summary: 'A live loss where the exact-search label and the played line point at an eval term.',
    hypothesis: {
      title: 'Eval term from a live loss',
      rationale: 'The calc block and the played line disagree in a way that is not one position.',
      expectedEffect: 'Changing the eval term raises paired win rate on the dev set.',
      testPlan: 'Sweep the eval term on paired games and the dev set. Do not add a species rule.',
      killCondition: 'No dev-set or win-rate gain, or held-out agreement drops.',
    },
  };
}

function unreadGames(paths: OpsPaths, ladderDirs: string[]): {
  games: AnalystGame[];
  liveNext: number;
  files: Record<string, number>;
  corrupt: number;
} {
  const live = readFileGames(paths.liveGames, readOffset(paths));
  const files = readFileOffsets(paths);
  const games = [...live.games];
  let corrupt = live.corrupt;
  const liveReal = fs.existsSync(paths.liveGames) ? safeReal(paths.liveGames) : '';
  const roots = new Set<string>();
  for (const dir of ladderDirs) {
    for (const file of listGameJsonl(dir)) {
      const resolved = safeReal(file);
      if (liveReal && resolved === liveReal) continue;
      if (roots.has(resolved)) continue;
      roots.add(resolved);
      const chunk = readFileGames(resolved, files[resolved] ?? 0);
      games.push(...chunk.games);
      corrupt += chunk.corrupt;
      files[resolved] = chunk.next;
    }
  }
  return { games, liveNext: live.next, files, corrupt };
}

function safeReal(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

function readFileGames(file: string, offset: number): { games: AnalystGame[]; next: number; corrupt: number } {
  if (!fs.existsSync(file)) return { games: [], next: 0, corrupt: 0 };
  const size = fs.statSync(file).size;
  const start = offset > size ? 0 : Math.max(0, offset);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const parsed = consumeJsonl(buf);
    const games: AnalystGame[] = [];
    for (const row of parsed.records) {
      const game = gameFromRow(row, file);
      if (game) games.push(game);
    }
    return { games, next: start + parsed.bytes, corrupt: parsed.corrupt };
  } finally {
    fs.closeSync(fd);
  }
}

function readOffset(paths: OpsPaths): number {
  if (!fs.existsSync(paths.analystOffset)) return 0;
  return Number(fs.readFileSync(paths.analystOffset, 'utf8')) || 0;
}

function writeOffset(paths: OpsPaths, offset: number): void {
  fs.writeFileSync(paths.analystOffset, String(offset));
}

function readFileOffsets(paths: OpsPaths): Record<string, number> {
  if (!fs.existsSync(paths.analystFiles)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.analystFiles, 'utf8')) as Record<string, number>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeFileOffsets(paths: OpsPaths, files: Record<string, number>): void {
  fs.writeFileSync(paths.analystFiles, JSON.stringify(files));
}

function markSeen(paths: OpsPaths, id: string): void {
  const ids = readSeen(paths);
  if (!ids.includes(id)) ids.push(id);
  fs.writeFileSync(paths.seenGames, JSON.stringify(ids));
}

function readSeen(paths: OpsPaths): string[] {
  if (!fs.existsSync(paths.seenGames)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.seenGames, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : [];
  } catch {
    return [];
  }
}