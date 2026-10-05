import type { GameResult, SideSituations } from '../bench/game.js';
import type { MetricSnapshot } from '../graph/regression-tracker.js';

export function snapshotFromResults(configId: string, results: GameResult[], commitSha?: string): MetricSnapshot {
  const mine = results.filter(game => game.p1ConfigId === configId || game.p2ConfigId === configId);
  const byOpponent: Record<string, { wins: number; games: number }> = {};
  const situations = emptySituations();
  let invalid = 0;
  let crashes = 0;
  let timeouts = 0;
  const times: number[] = [];
  for (const game of mine) {
    const side = game.p1ConfigId === configId ? 'p1' : 'p2';
    const opponent = side === 'p1' ? game.p2ConfigId : game.p1ConfigId;
    const bucket = byOpponent[opponent] ?? { wins: 0, games: 0 };
    bucket.games++;
    if ((side === 'p1' && game.winner === 'p1') || (side === 'p2' && game.winner === 'p2')) bucket.wins++;
    byOpponent[opponent] = bucket;
    const sit = side === 'p1' ? game.p1Situations : game.p2Situations;
    foldSituation(situations, sit, game.winner === side);
    invalid += side === 'p1' ? game.p1Invalid : game.p2Invalid;
    if (game.crashed) crashes++;
    const turnTimes = side === 'p1' ? game.p1TurnTimes : game.p2TurnTimes;
    times.push(...turnTimes);
    timeouts += turnTimes.filter(ms => ms > 2000).length;
  }
  const games = mine.length;
  const winRate = (opponent: string) => {
    const bucket = byOpponent[opponent];
    return bucket && bucket.games ? bucket.wins / bucket.games : 0;
  };
  return {
    win_rate_by_opponent: Object.fromEntries(Object.entries(byOpponent).map(([id, bucket]) => [id, winRate(id)])),
    situations,
    decisions: {
      switch_frequency: 0,
      switch_quality: 0,
      setup_sweeps_allowed: 0,
      setup_sweeps_achieved: 0,
      speed_option_survival: 0,
      blunder_rate: 0,
    },
    diagnostic_suite: { total: 0, passed: 0, pass_rate: 0 },
    guardrails: {
      invalid_choices: invalid,
      crashes,
      timeouts,
      p99_latency_ms: percentile(times, 0.99),
      fallback_rate: 0,
      state_mismatches: 0,
    },
    games_played: games,
    timestamp: Date.now(),
    commit_sha: commitSha,
  };
}

function foldSituation(
  into: MetricSnapshot['situations'],
  sit: SideSituations,
  won: boolean
): void {
  const mark = (key: keyof MetricSnapshot['situations'], on: boolean) => {
    if (!on) return;
    into[key].games++;
    if (won) into[key].wins++;
    into[key].win_rate = into[key].games ? into[key].wins / into[key].games : 0;
  };
  mark('leading', sit.leading > sit.trailing && sit.leading > 0);
  mark('trailing', sit.trailing > sit.leading && sit.trailing > 0);
  mark('endgame_1v1', sit.endgame1v1);
  mark('endgame_2v2', sit.endgame2v2);
  mark('hazard_advantage', sit.hazardAdvantage);
  mark('hazard_disadvantage', sit.hazardDisadvantage);
  mark('weather_active', sit.weather);
  mark('tera_first', sit.teraFirst);
  mark('tera_second', sit.teraSecond);
}

function emptySituations(): MetricSnapshot['situations'] {
  const cell = () => ({ games: 0, wins: 0, win_rate: 0 });
  return {
    leading: cell(),
    trailing: cell(),
    endgame_1v1: cell(),
    endgame_2v2: cell(),
    hazard_advantage: cell(),
    hazard_disadvantage: cell(),
    weather_active: cell(),
    tera_first: cell(),
    tera_second: cell(),
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}
