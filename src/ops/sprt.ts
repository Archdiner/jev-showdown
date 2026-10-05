/** Two-sided binomial SPRT. H0 is even with the champion (p = 0.5). H1 is +10 Elo. */
export const SPRT_P0 = 0.5;
export const SPRT_P1 = 1 / (1 + 10 ** (-10 / 400));
export const SPRT_BOUNDARY = Math.log((1 - 0.05) / 0.05);

export type SprtVerdict = 'promote' | 'reject' | 'continue';

export function sprt(wins: number, losses: number, p0 = SPRT_P0, p1 = SPRT_P1): SprtVerdict {
  if (wins + losses === 0) return 'continue';
  const llr = wins * Math.log(p1 / p0) + losses * Math.log((1 - p1) / (1 - p0));
  if (llr >= SPRT_BOUNDARY) return 'promote';
  if (llr <= -SPRT_BOUNDARY) return 'reject';
  return 'continue';
}

export interface SideGame {
  winner: 'p1' | 'p2' | 'tie';
  p1Id: string;
  p2Id: string;
  p1Invalid: number;
  p2Invalid: number;
  crashed: boolean;
}

export interface SideTally {
  wins: number;
  losses: number;
  invalid: number;
  crashes: number;
}

/** Ties count as half a win and half a loss. Only the named side's invalid choices count. */
export function tallySide(games: SideGame[], id: string): SideTally {
  const tally: SideTally = { wins: 0, losses: 0, invalid: 0, crashes: 0 };
  for (const game of games) {
    const onP1 = game.p1Id === id;
    const onP2 = game.p2Id === id;
    if (onP1 === onP2) continue;
    if (game.winner === 'tie') {
      tally.wins += 0.5;
      tally.losses += 0.5;
    } else if ((onP1 && game.winner === 'p1') || (onP2 && game.winner === 'p2')) {
      tally.wins += 1;
    } else {
      tally.losses += 1;
    }
    tally.invalid += onP1 ? game.p1Invalid : game.p2Invalid;
    if (game.crashed) tally.crashes += 1;
  }
  return tally;
}

/** The factory may propose live-approved only when this SPRT would promote. */
export function liveProposalAllowed(wins: number, losses: number, invalid: number): boolean {
  return invalid === 0 && sprt(wins, losses) === 'promote';
}

/** Paired games a challenger may play before an inconclusive SPRT is handed to the gatekeeper. */
export function sprtMaxGames(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OPS_SPRT_MAX_GAMES);
  if (!Number.isFinite(raw) || raw < 2) return 1200;
  return Math.floor(raw);
}
