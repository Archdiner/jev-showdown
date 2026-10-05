import type { EndReason, GameRecord } from './parse.js';
import { wilson, type Wilson } from './stats.js';

export type RatingBand = 'unknown' | 'under-1200' | '1200-1399' | '1400-1599' | '1600-plus';

export const RATING_BANDS: RatingBand[] = ['unknown', 'under-1200', '1200-1399', '1400-1599', '1600-plus'];

export function ratingBand(rating: number | null): RatingBand {
  if (rating === null || !Number.isFinite(rating)) return 'unknown';
  if (rating < 1200) return 'under-1200';
  if (rating < 1400) return '1200-1399';
  if (rating < 1600) return '1400-1599';
  return '1600-plus';
}

export interface Tally {
  wins: number;
  losses: number;
  ties: number;
  games: number;
  winRate: number | null;
  ciLow: number | null;
  ciHigh: number | null;
}

export function tally(games: GameRecord[]): Tally {
  const wins = games.filter(game => game.outcome === 'win').length;
  const losses = games.filter(game => game.outcome === 'loss').length;
  const ties = games.filter(game => game.outcome === 'tie').length;
  const decided = wins + losses;
  const interval: Wilson = wilson(wins, decided > 0 ? decided : games.length);
  return { wins, losses, ties, games: games.length, winRate: interval.rate, ciLow: interval.low, ciHigh: interval.high };
}

export interface GameReport {
  all: Tally;
  strategy: Tally;
  timerDisconnect: Tally;
  crash: Tally;
  unclassifiedLosses: number;
  strategyLosses: number;
  timerDisconnectLosses: number;
  crashLosses: number;
}

export interface ConfigPanel {
  configId: string;
  role: 'champion' | 'challenger' | null;
  share: number | null;
  wins: number;
  losses: number;
  ties: number;
  games: number;
  /** Sum of (rating after − rating before) where both were recorded. */
  eloDelta: number | null;
  invalidMoves: number;
  report: GameReport;
}

/** One scorecard per config, plus W/L, Elo change, and invalid moves. */
export function configPanels(games: GameRecord[]): ConfigPanel[] {
  const groups = new Map<string, GameRecord[]>();
  for (const game of games) {
    const id = game.configId || 'unknown';
    const rows = groups.get(id) ?? [];
    rows.push(game);
    groups.set(id, rows);
  }
  return [...groups.entries()].map(([configId, rows]) => {
    const wins = rows.filter(game => game.outcome === 'win').length;
    const losses = rows.filter(game => game.outcome === 'loss').length;
    const ties = rows.filter(game => game.outcome === 'tie').length;
    let elo = 0;
    let eloGames = 0;
    let invalidMoves = 0;
    for (const game of rows) {
      if (game.ratingBefore !== null && game.ratingAfter !== null) {
        elo += game.ratingAfter - game.ratingBefore;
        eloGames += 1;
      }
      if (game.invalid !== null) invalidMoves += game.invalid;
    }
    return {
      configId,
      role: rows.find(game => game.role)?.role ?? null,
      share: rows.find(game => game.share !== null)?.share ?? null,
      wins,
      losses,
      ties,
      games: rows.length,
      eloDelta: eloGames === 0 ? null : elo,
      invalidMoves,
      report: reportGames(rows),
    };
  }).sort((a, b) => {
    const rank = (role: ConfigPanel['role']) => role === 'champion' ? 0 : role === 'challenger' ? 1 : 2;
    return rank(a.role) - rank(b.role) || b.games - a.games || a.configId.localeCompare(b.configId);
  });
}

/** Strategy keeps KO and forfeit games. Timer, disconnect, and crash games are counted aside. */
export function reportGames(games: GameRecord[]): GameReport {
  const aside = new Set(['timer-ours', 'timer-theirs', 'disconnect', 'crash']);
  const strategy = games.filter(game => !game.endReason || !aside.has(game.endReason));
  return {
    all: tally(games),
    strategy: tally(strategy),
    timerDisconnect: tally(games.filter(game => game.endReason === 'timer-ours' || game.endReason === 'timer-theirs' || game.endReason === 'disconnect')),
    crash: tally(games.filter(game => game.endReason === 'crash')),
    unclassifiedLosses: games.filter(game => game.lossClass === 'unclassified').length,
    strategyLosses: games.filter(game => game.lossClass === 'strategy').length,
    timerDisconnectLosses: games.filter(game => game.lossClass === 'timer-disconnect').length,
    crashLosses: games.filter(game => game.lossClass === 'crash').length,
  };
}

export function filterGames(games: GameRecord[], query: { endReason?: string | null; band?: string | null }): GameRecord[] {
  const endReason = query.endReason && query.endReason !== 'any' ? query.endReason : null;
  const band = query.band && query.band !== 'any' ? query.band : null;
  return games.filter(game => {
    if (band && ratingBand(game.opponentRating) !== band) return false;
    if (!endReason) return true;
    if (endReason === 'strategy') return game.lossClass === 'strategy' || game.endReason === 'ko' || game.endReason === 'opponent-forfeit' || game.endReason === 'our-forfeit';
    if (endReason === 'timer-disconnect') return game.lossClass === 'timer-disconnect' || game.endReason === 'timer-theirs';
    return game.endReason === endReason as EndReason;
  });
}
