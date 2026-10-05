import { teamsForSeed } from '../engine/exact/battle-utils.js';
import { GameJob, GameResult, runGame } from '../bench/game.js';
import { runGamesParallel } from '../bench/pool.js';
import type { InformationMode } from '../client/hidden-info.js';
import type { BotSpec } from '../config/interfaces.js';

/** Each seed is played twice with swapped sides. `games` is the total. */
export async function playPaired(
  a: BotSpec,
  b: BotSpec,
  games: number,
  seedStart: number,
  parallel = true,
  information?: InformationMode,
): Promise<GameResult[]> {
  if (games % 2 !== 0) throw new Error('games must be even: each seed is played on both sides');
  const pairs = games / 2;
  const jobs: GameJob[] = [];
  for (let i = 0; i < pairs; i++) {
    const seed = seedStart + i;
    const teams = teamsForSeed(seed);
    jobs.push({ index: jobs.length, seed, p1Team: teams.p1, p2Team: teams.p2, p1: a, p2: b, information });
    jobs.push({ index: jobs.length, seed, p1Team: teams.p1, p2Team: teams.p2, p1: b, p2: a, information });
  }
  if (!parallel || jobs.length < 2) {
    const results: GameResult[] = [];
    for (const job of jobs) results.push(await runGame(job));
    return results;
  }
  return runGamesParallel(jobs);
}

export function sideWinRate(results: GameResult[], configId: string): { wins: number; games: number; winRate: number } {
  let wins = 0;
  let games = 0;
  for (const game of results) {
    const onP1 = game.p1ConfigId === configId;
    const onP2 = game.p2ConfigId === configId;
    if (!onP1 && !onP2) continue;
    if (onP1 && onP2) continue;
    games++;
    if ((onP1 && game.winner === 'p1') || (onP2 && game.winner === 'p2')) wins++;
  }
  return { wins, games, winRate: games ? wins / games : 0 };
}


/** Factory / gate self-play guard: any invalid choice fails the config. */
export function assertZeroInvalid(results: GameResult[], label = 'self-play'): void {
  const invalid = results.reduce((sum, game) => sum + game.p1Invalid + game.p2Invalid, 0);
  if (invalid > 0) {
    const sample = results.find(game => game.p1Invalid > 0 || game.p2Invalid > 0);
    throw new Error(
      `${label} guardrail failed: invalid=${invalid}`
      + (sample ? ` (seed=${sample.seed} error=${sample.error ?? 'illegal choice'})` : ''),
    );
  }
}
