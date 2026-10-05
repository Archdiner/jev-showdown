import * as fs from 'fs';
import { battleFromInputLog } from '../config/adapters.js';
import type { PositionRecord } from '../config/interfaces.js';
import { minePosition } from '../config/positions.js';
import { generalizeFinding } from '../exp/analyst.js';
import { GatewayClient } from '../llm/gateway-client.js';
import { LossReviewer, writeFindingAsHypothesis, type LossFinding } from '../llm/loss-reviewer.js';
import { openDb } from './db.js';
import { beat } from './heartbeat.js';
import { appendJsonl, type OpsPaths } from './paths.js';
import { observeLog, readCounts, scrapeReplay, writePriors } from './priors.js';
import { enqueue } from './queue.js';

interface LiveGame {
  id: string;
  winner?: string | null;
  outcome?: 'win' | 'loss' | 'tie';
  log?: string;
  inputLog?: string;
  configId?: string;
}

export async function runAnalyst(paths: OpsPaths, opts: { once?: boolean; replay?: string } = {}): Promise<number> {
  beat(paths, 'analyst', 'ok', 'up');
  if (opts.replay) {
    const log = await scrapeReplay(opts.replay);
    const counts = readCounts(paths);
    observeLog(log, counts);
    writePriors(paths, counts);
  }
  let reviewed = 0;
  do {
    const games = unreadGames(paths);
    for (const game of games) {
      if (seen(paths, game.id)) continue;
      await reviewGame(paths, game);
      markSeen(paths, game.id);
      reviewed += 1;
    }
    writeOffset(paths);
    beat(paths, 'analyst', 'ok', `reviewed ${reviewed}`);
    if (opts.once) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  } while (!opts.once);
  beat(paths, 'analyst', 'stopped', 'exit');
  return reviewed;
}

async function reviewGame(paths: OpsPaths, game: LiveGame): Promise<void> {
  const counts = readCounts(paths);
  observeLog(game.log || '', counts);
  writePriors(paths, counts);
  const outcome = game.outcome ?? game.winner;
  if (outcome !== 'loss') return;

  const mined = mineCritical(paths, game);
  const calcText = mined
    ? `depth ${mined.labelDepth} exact search label: ${mined.label}`
    : 'No reconstructed battle, so there is no calc block.';
  const finding = await reviewLoss(paths, game, calcText);
  const db = openDb(paths);
  try {
    writeFindingAsHypothesis(db, generalizeFinding(finding), {
      model: process.env.AI_GATEWAY_API_KEY ? 'xai/grok-4.7' : 'local-fallback',
      battleId: game.id,
      sourcePath: paths.liveGames,
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

function mineCritical(paths: OpsPaths, game: LiveGame): PositionRecord | null {
  if (!game.inputLog?.includes('>start')) return null;
  try {
    const battle = battleFromInputLog(game.inputLog);
    const mined = minePosition({ battle, side: 'p1', seed: 1, labelDepth: 2, outPath: paths.pool });
    appendJsonl(paths.regressionSuite, mined);
    return mined;
  } catch {
    return null;
  }
}

async function reviewLoss(paths: OpsPaths, game: LiveGame, calcText: string): Promise<LossFinding> {
  if (process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_AI_GATEWAY_KEY) {
    const reviewer = new LossReviewer(new GatewayClient());
    const result = await reviewer.review(game.log || '', {
      calcText,
      battleId: game.id,
      sourcePath: paths.liveGames,
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

function unreadGames(paths: OpsPaths): LiveGame[] {
  if (!fs.existsSync(paths.liveGames)) return [];
  const size = fs.statSync(paths.liveGames).size;
  const offset = Math.min(readOffset(paths), size);
  const fd = fs.openSync(paths.liveGames, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    return buf.toString('utf8').split('\n').map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line) as LiveGame);
  } finally {
    fs.closeSync(fd);
  }
}

function readOffset(paths: OpsPaths): number {
  if (!fs.existsSync(paths.analystOffset)) return 0;
  return Number(fs.readFileSync(paths.analystOffset, 'utf8')) || 0;
}

function writeOffset(paths: OpsPaths): void {
  const size = fs.existsSync(paths.liveGames) ? fs.statSync(paths.liveGames).size : 0;
  fs.writeFileSync(paths.analystOffset, String(size));
}

function seen(paths: OpsPaths, id: string): boolean {
  return readSeen(paths).includes(id);
}

function markSeen(paths: OpsPaths, id: string): void {
  const ids = readSeen(paths);
  if (!ids.includes(id)) ids.push(id);
  fs.writeFileSync(paths.seenGames, JSON.stringify(ids));
}

function readSeen(paths: OpsPaths): string[] {
  if (!fs.existsSync(paths.seenGames)) return [];
  return JSON.parse(fs.readFileSync(paths.seenGames, 'utf8')) as string[];
}
