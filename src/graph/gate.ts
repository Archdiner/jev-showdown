import { GraphDB } from './db.js';
import { specForAlias } from '../config/aliases.js';
import { isBotSpec } from '../config/load.js';
import { championBlueprint, specFromId } from '../engine/exact/policies.js';
import { ExactConfig } from '../engine/exact/search.js';
import { teamsForSeed } from '../engine/exact/battle-utils.js';
import { BenchPlayer, GameJob, GameResult as BenchGame } from '../bench/game.js';
import { runGamesParallel } from '../bench/pool.js';
import { heldOutPasses, scoreSplit, SplitScore } from '../engine/exact/position-sets.js';

// Gate configuration (encode metrics here, not prose)
export const GATE_CONFIG = {
  // SPRT parameters for promotion
  sprt: {
    elo0: 0,      // H0: no difference
    elo1: 10,     // H1: +10 Elo improvement
    alpha: 0.05,  // Type I error (false positive)
    beta: 0.05,   // Type II error (false negative)
  },
  
  // Hard guardrails (any violation = fail)
  guardrails: {
    max_invalid_choices: 0,
    max_crashes: 0,
    max_timeouts: 0,
    max_p99_turn_time_ms: 2000,
    max_fallback_rate: 0.01, // 1%
    max_state_mismatches: 0,
  },
  
  // Paired seeds per opponent. Each seed is played twice with swapped sides,
  // so 150 seeds is 300 games.
  min_games_per_opponent: 150,
  
  // Confidence level for Wilson CI
  confidence: 0.95,
  
  // Panel opponents (frozen versions)
  panel: [
    'random-v1',
    'maxdamage-v1',
    'exact-1ply',
  ],
};

export interface PlayCount {
  decisions: number;
  switches: number;
  predicted: number;
  answered: number;
}

export interface GameResult {
  winner: 'p1' | 'p2' | 'tie';
  p1: string; // bot id
  p2: string;
  seed: number;
  turns: number;
  protocol_log: string;
  p1_metrics: BotMetrics;
  p2_metrics: BotMetrics;
  p1_play?: PlayCount;
  p2_play?: PlayCount;
}

export interface BotMetrics {
  invalid_choices: number;
  crashes: number;
  timeouts: number;
  turn_times_ms: number[];
  fallback_rate: number;
  state_mismatches: number;
  eval_swings: number[]; // for blunder detection
}

export interface HeldOutCheck {
  ok: boolean;
  reason: string;
  positions?: number;
  replay_positions?: number;
  forced_win_hit?: number;
  forced_win_total?: number;
  deep_hit?: number;
  deep_total?: number;
  max_damage_deep_hit?: number;
  max_damage_deep_total?: number;
}

export interface SprtResult {
  elo0: number;
  elo1: number;
  alpha: number;
  beta: number;
  llr: number;
  decision: 'accept_h1' | 'accept_h0' | 'continue';
}

export interface TournamentResult {
  challenger_id: string;
  champion_id: string;
  games: GameResult[];
  panel_results: PanelResult[];
  guardrails: GuardrailsCheck;
  held_out: HeldOutCheck;
  verdict: 'promoted' | 'rejected';
  reason: string;
  sprt_result: SprtResult;
}

export interface PanelResult {
  opponent: string;
  challenger_elo: number;
  champion_elo: number;
  elo_diff: number;
  win_rate: number;
  ci_lower: number;
  ci_upper: number;
  games: number;
  significant_improvement: boolean;
  significant_regression: boolean;
}

export interface GuardrailsCheck {
  passed: boolean;
  invalid_choices: number;
  crashes: number;
  timeouts: number;
  p99_turn_time_ms: number;
  fallback_rate: number;
  state_mismatches: number;
}

export function eloWinProbability(eloDiff: number): number {
  return 1 / (1 + 10 ** (-eloDiff / 400));
}

/** SPRT described by GATE_CONFIG.sprt. elo0 0 is an even match with the champion. */
export function sprtDecision(
  wins: number,
  losses: number,
  params: { elo0: number; elo1: number; alpha: number; beta: number } = GATE_CONFIG.sprt,
): SprtResult {
  const p0 = eloWinProbability(params.elo0);
  const p1 = eloWinProbability(params.elo1);
  const boundary = Math.log((1 - params.beta) / params.alpha);
  const played = wins + losses;
  const llr = played === 0
    ? 0
    : wins * Math.log(p1 / p0) + losses * Math.log((1 - p1) / (1 - p0));
  let decision: SprtResult['decision'] = 'continue';
  if (played > 0 && llr >= boundary) decision = 'accept_h1';
  else if (played > 0 && llr <= -boundary) decision = 'accept_h0';
  return {
    elo0: params.elo0,
    elo1: params.elo1,
    alpha: params.alpha,
    beta: params.beta,
    llr,
    decision,
  };
}

export function gateOpponents(championId: string): string[] {
  const ids = [...GATE_CONFIG.panel];
  if (!ids.includes(championId)) ids.push(championId);
  return ids;
}

/** Ties are half a win and half a loss for the named player. */
export function scoreAgainst(playerId: string, games: GameResult[]): { wins: number; losses: number; games: number } {
  let wins = 0;
  let losses = 0;
  let n = 0;
  for (const game of games) {
    const mine = game.p1 === playerId ? 'p1' : game.p2 === playerId ? 'p2' : null;
    if (!mine) continue;
    n += 1;
    if (game.winner === 'tie') {
      wins += 0.5;
      losses += 0.5;
    } else if (game.winner === mine) {
      wins += 1;
    } else {
      losses += 1;
    }
  }
  return { wins, losses, games: n };
}

export function guardrailsFor(botId: string, games: GameResult[]): GuardrailsCheck {
  const botGames = games.filter(game => game.p1 === botId || game.p2 === botId);
  const metrics = botGames.map(game => game.p1 === botId ? game.p1_metrics : game.p2_metrics);
  const totalInvalid = metrics.reduce((sum, row) => sum + row.invalid_choices, 0);
  const totalCrashes = metrics.reduce((sum, row) => sum + row.crashes, 0);
  const totalTimeouts = metrics.reduce((sum, row) => sum + row.timeouts, 0);
  const allTurnTimes = metrics.flatMap(row => row.turn_times_ms);
  allTurnTimes.sort((a, b) => a - b);
  const p99Index = Math.floor(allTurnTimes.length * 0.99);
  const p99TurnTime = allTurnTimes[p99Index] || 0;
  const avgFallback = metrics.reduce((sum, row) => sum + row.fallback_rate, 0) / metrics.length;
  const totalMismatches = metrics.reduce((sum, row) => sum + row.state_mismatches, 0);
  const passed = (
    totalInvalid <= GATE_CONFIG.guardrails.max_invalid_choices &&
    totalCrashes <= GATE_CONFIG.guardrails.max_crashes &&
    totalTimeouts <= GATE_CONFIG.guardrails.max_timeouts &&
    p99TurnTime <= GATE_CONFIG.guardrails.max_p99_turn_time_ms &&
    avgFallback <= GATE_CONFIG.guardrails.max_fallback_rate &&
    totalMismatches <= GATE_CONFIG.guardrails.max_state_mismatches
  );
  return {
    passed,
    invalid_choices: totalInvalid,
    crashes: totalCrashes,
    timeouts: totalTimeouts,
    p99_turn_time_ms: p99TurnTime,
    fallback_rate: avgFallback,
    state_mismatches: totalMismatches,
  };
}

const EXACT_HELD_OUT = new Set(['greedy-1ply', 'depth-n', 'expectimax', 'mcts-stub']);

/** Non-exact challengers do not inherit the default 1-ply held-out score. */
export function heldOutPlan(challengerId: string): { ok: true; config: ExactConfig } | { ok: false; reason: string } {
  try {
    const spec = specFromId(challengerId);
    if (spec.kind !== 'exact') return { ok: false, reason: 'held-out requires the challenger exact search' };
    return { ok: true, config: spec.config };
  } catch {
    // A config path or alias is resolved below.
  }
  try {
    const player = specForAlias(challengerId, 'gate');
    if (!isBotSpec(player) || !EXACT_HELD_OUT.has(player.config.search.id)) {
      return { ok: false, reason: 'held-out requires the challenger exact search' };
    }
    const params = player.config.search.params;
    return {
      ok: true,
      config: {
        depth: params.depth,
        samples: params.samples,
        opponentModel: params.opponentModel,
        evalMode: params.evalMode === 'full' ? 'full' : 'hp',
        errorAsLoss: false,
      },
    };
  } catch {
    return { ok: false, reason: `unknown challenger ${challengerId}` };
  }
}

export function decidePromotion(input: {
  championId: string;
  panelResults: PanelResult[];
  guardrails: GuardrailsCheck;
  heldOut: HeldOutCheck;
  championWins: number;
  championLosses: number;
  guardrailReason?: string;
  sprt?: { elo0: number; elo1: number; alpha: number; beta: number };
}): { verdict: 'promoted' | 'rejected'; reason: string; sprt_result: SprtResult } {
  const sprt_result = sprtDecision(input.championWins, input.championLosses, input.sprt ?? GATE_CONFIG.sprt);
  if (!input.guardrails.passed) {
    return {
      verdict: 'rejected',
      reason: input.guardrailReason ?? 'Failed hard guardrails',
      sprt_result,
    };
  }
  const regressions = input.panelResults.filter(row => row.significant_regression && row.opponent !== input.championId);
  if (regressions.length > 0) {
    return {
      verdict: 'rejected',
      reason: `Significant regression vs ${regressions.map(row => row.opponent).join(', ')}`,
      sprt_result,
    };
  }
  if (sprt_result.decision === 'accept_h0') {
    return { verdict: 'rejected', reason: `SPRT accept_h0 vs ${input.championId}`, sprt_result };
  }
  if (sprt_result.decision !== 'accept_h1') {
    return {
      verdict: 'rejected',
      reason: `SPRT continue vs ${input.championId}; beating the panel is not a promotion`,
      sprt_result,
    };
  }
  if (!input.heldOut.ok) {
    return { verdict: 'rejected', reason: input.heldOut.reason, sprt_result };
  }
  return {
    verdict: 'promoted',
    reason: `SPRT accept_h1 vs ${input.championId}. ${input.heldOut.reason}`,
    sprt_result,
  };
}

/** Config aliases play through buildBot. Engine-only ids, including switch-depth2, play the policy. */
export function gatePlayer(id: string): BenchPlayer {
  try {
    return specForAlias(id, 'gate');
  } catch (aliasError) {
    try {
      return specFromId(id);
    } catch {
      throw aliasError;
    }
  }
}

export class Gate {
  private db: GraphDB;

  constructor(db?: GraphDB) {
    this.db = db || new GraphDB();
  }

  /**
   * Run gate tournament: challenger vs champion
   * Returns verdict and automatically writes to graph
   */
  async runTournament(challengerId: string, championId: string): Promise<TournamentResult> {
    console.log(`\n=== Gate Tournament ===`);
    console.log(`Challenger: ${challengerId}`);
    console.log(`Champion: ${championId}\n`);

    const games: GameResult[] = [];
    const panelResults: PanelResult[] = [];
    let championWins = 0;
    let championLosses = 0;

    for (const opponent of gateOpponents(championId)) {
      console.log(`\nTesting vs ${opponent}...`);
      const opponentGames = await this.runPairedGames(
        challengerId,
        opponent,
        GATE_CONFIG.min_games_per_opponent
      );
      games.push(...opponentGames);
      if (opponent === championId) {
        const scored = scoreAgainst(challengerId, opponentGames);
        championWins = scored.wins;
        championLosses = scored.losses;
      }
      const result = this.analyzePanelResults(challengerId, opponent, opponentGames, opponent === championId);
      panelResults.push(result);
      
      console.log(`  Challenger: ${result.challenger_elo.toFixed(1)} Elo (${(result.win_rate * 100).toFixed(1)}% WR)`);
      console.log(`  Champion: ${result.champion_elo.toFixed(1)} Elo`);
      console.log(`  Diff: ${result.elo_diff > 0 ? '+' : ''}${result.elo_diff.toFixed(1)} Elo`);
      console.log(`  95% CI: [${(result.ci_lower * 100).toFixed(1)}%, ${(result.ci_upper * 100).toFixed(1)}%]`);
    }

    // Check hard guardrails
    const guardrails = this.checkGuardrails(challengerId, games);
    
    console.log(`\n=== Guardrails ===`);
    console.log(`Invalid choices: ${guardrails.invalid_choices} (max ${GATE_CONFIG.guardrails.max_invalid_choices})`);
    console.log(`Crashes: ${guardrails.crashes} (max ${GATE_CONFIG.guardrails.max_crashes})`);
    console.log(`Timeouts: ${guardrails.timeouts} (max ${GATE_CONFIG.guardrails.max_timeouts})`);
    console.log(`P99 turn time: ${guardrails.p99_turn_time_ms.toFixed(0)}ms (max ${GATE_CONFIG.guardrails.max_p99_turn_time_ms}ms)`);
    console.log(`Fallback rate: ${(guardrails.fallback_rate * 100).toFixed(2)}% (max ${(GATE_CONFIG.guardrails.max_fallback_rate * 100).toFixed(2)}%)`);
    console.log(`State mismatches: ${guardrails.state_mismatches} (max ${GATE_CONFIG.guardrails.max_state_mismatches})`);
    console.log(`Passed: ${guardrails.passed ? 'YES' : 'NO'}`);

    const heldOut = this.scoreHeldOut(challengerId);
    console.log(`\n=== Held-out ===`);
    console.log(heldOut.reason);

    const { verdict, reason, sprt_result } = this.makeVerdict(
      panelResults,
      guardrails,
      heldOut,
      championId,
      championWins,
      championLosses,
    );
    
    console.log(`\n=== Verdict: ${verdict.toUpperCase()} ===`);
    console.log(`Reason: ${reason}\n`);

    // Write result to graph
    await this.recordResult({
      challenger_id: challengerId,
      champion_id: championId,
      games,
      panel_results: panelResults,
      guardrails,
      held_out: heldOut,
      verdict,
      reason,
      sprt_result,
    });

    return {
      challenger_id: challengerId,
      champion_id: championId,
      games,
      panel_results: panelResults,
      guardrails,
      held_out: heldOut,
      verdict,
      reason,
      sprt_result,
    };
  }

  private async runPairedGames(
    challenger: string,
    opponent: string,
    numPairs: number
  ): Promise<GameResult[]> {
    // Same teams and seed, policies swapped. The named opponent is who
    // actually plays, including the current champion id.
    const challengerSpec = gatePlayer(challenger);
    const opponentSpec = gatePlayer(opponent);
    const jobs: GameJob[] = [];
    const labels: Array<{ p1: string; p2: string }> = [];

    for (let i = 0; i < numPairs; i++) {
      const seed = i + 1;
      const teams = teamsForSeed(seed);
      jobs.push({
        index: jobs.length,
        seed,
        p1Team: teams.p1,
        p2Team: teams.p2,
        p1: challengerSpec,
        p2: opponentSpec,
      });
      labels.push({ p1: challenger, p2: opponent });
      jobs.push({
        index: jobs.length,
        seed,
        p1Team: teams.p1,
        p2Team: teams.p2,
        p1: opponentSpec,
        p2: challengerSpec,
      });
      labels.push({ p1: opponent, p2: challenger });
    }

    console.log(`  ${jobs.length} games (${numPairs} seeds x 2 sides) ${challenger} vs ${opponent}`);
    const played = await runGamesParallel(jobs);
    return played.map((game, i) => this.toGateResult(game, labels[i], jobs[i].seed));
  }

  private toGateResult(
    game: BenchGame,
    labels: { p1: string; p2: string },
    seed: number,
  ): GameResult {
    const metrics = (invalid: number, times: number[], crashed: boolean): BotMetrics => ({
      invalid_choices: invalid,
      crashes: crashed ? 1 : 0,
      timeouts: times.filter(ms => ms > GATE_CONFIG.guardrails.max_p99_turn_time_ms).length,
      turn_times_ms: times,
      fallback_rate: 0,
      state_mismatches: 0,
      eval_swings: [],
    });
    return {
      winner: game.winner,
      p1: labels.p1,
      p2: labels.p2,
      seed,
      turns: game.turns,
      protocol_log: game.error || '',
      p1_metrics: metrics(game.p1Invalid, game.p1TurnTimes, game.crashed),
      p2_metrics: metrics(game.p2Invalid, game.p2TurnTimes, game.crashed),
      p1_play: { decisions: game.p1Decisions || 0, switches: game.p1Switches || 0, predicted: game.p1Predicted || 0, answered: game.p1Answered || 0 },
      p2_play: { decisions: game.p2Decisions || 0, switches: game.p2Switches || 0, predicted: game.p2Predicted || 0, answered: game.p2Answered || 0 },
    };
  }

  private analyzePanelResults(
    challenger: string,
    opponent: string,
    games: GameResult[],
    againstChampion: boolean,
  ): PanelResult {
    const scored = scoreAgainst(challenger, games);
    const winRate = scored.games > 0 ? scored.wins / scored.games : 0;
    const [ciLower, ciUpper] = this.wilsonCI(scored.wins, scored.games, GATE_CONFIG.confidence);
    const challengerElo = this.winRateToElo(winRate);
    const championElo = 1500;
    const sprt = sprtDecision(scored.wins, scored.losses);

    return {
      opponent,
      challenger_elo: challengerElo,
      champion_elo: championElo,
      elo_diff: challengerElo - championElo,
      win_rate: winRate,
      ci_lower: ciLower,
      ci_upper: ciUpper,
      games: scored.games,
      significant_improvement: againstChampion ? sprt.decision === 'accept_h1' : ciLower > 0.5,
      significant_regression: againstChampion ? sprt.decision === 'accept_h0' : ciUpper < 0.5,
    };
  }

  private wilsonCI(wins: number, total: number, confidence: number): [number, number] {
    if (total === 0) return [0, 1];
    
    const z = 1.96; // 95% confidence
    const p = wins / total;
    const denominator = 1 + z * z / total;
    const center = (p + z * z / (2 * total)) / denominator;
    const margin = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator;
    
    return [
      Math.max(0, center - margin),
      Math.min(1, center + margin)
    ];
  }

  private winRateToElo(winRate: number): number {
    // Elo formula: winRate = 1 / (1 + 10^(-eloDiff/400))
    // Solving for eloDiff: eloDiff = -400 * log10(1/winRate - 1)
    if (winRate >= 0.999) return 2000;
    if (winRate <= 0.001) return 1000;
    return 1500 - 400 * Math.log10(1 / winRate - 1);
  }

  private playSummary(challengerId: string, games: GameResult[]): {
    switch_rate: number;
    punish_rate: number;
    decisions: number;
    switches: number;
    predicted: number;
    answered: number;
  } {
    let decisions = 0;
    let switches = 0;
    let predicted = 0;
    let answered = 0;
    for (const game of games) {
      const play = game.p1 === challengerId ? game.p1_play : game.p2 === challengerId ? game.p2_play : undefined;
      if (!play) continue;
      decisions += play.decisions;
      switches += play.switches;
      predicted += play.predicted;
      answered += play.answered;
    }
    return {
      switch_rate: decisions ? switches / decisions : 0,
      punish_rate: predicted ? answered / predicted : 0,
      decisions,
      switches,
      predicted,
      answered,
    };
  }

  private checkGuardrails(botId: string, games: GameResult[]): GuardrailsCheck {
    return guardrailsFor(botId, games);
  }

  /**
   * Held-out positions are scored in aggregate. A missing file or a missed
   * forced win rejects the challenger. Agreement with the always-attack
   * labeler is required only for an always-attack search. A switch model
   * is supposed to disagree with that labeler; its promotion test is the
   * paired win rate. Hand-written diagnostics are not consulted.
   */
  private scoreHeldOut(challengerId: string): HeldOutCheck {
    const plan = heldOutPlan(challengerId);
    if (!plan.ok) return { ok: false, reason: plan.reason };
    const config = plan.config;
    let score: SplitScore;
    try {
      score = scoreSplit('heldout', config);
    } catch {
      return { ok: false, reason: 'held-out set was not generated' };
    }
    const verdict = heldOutPasses(score, { attackerAgreement: config.opponentModel !== 'switch' });
    return {
      ok: verdict.ok,
      reason: verdict.reason,
      positions: score.positions,
      replay_positions: score.replayPositions,
      forced_win_hit: score.forcedWin.hit,
      forced_win_total: score.forcedWin.total,
      deep_hit: score.deepAgree.hit,
      deep_total: score.deepAgree.total,
      max_damage_deep_hit: score.maxDamageDeepAgree.hit,
      max_damage_deep_total: score.maxDamageDeepAgree.total,
    };
  }

  private makeVerdict(
    panelResults: PanelResult[],
    guardrails: GuardrailsCheck,
    heldOut: HeldOutCheck,
    championId: string,
    championWins: number,
    championLosses: number,
  ): { verdict: 'promoted' | 'rejected'; reason: string; sprt_result: SprtResult } {
    return decidePromotion({
      championId,
      panelResults,
      guardrails,
      heldOut,
      championWins,
      championLosses,
      guardrailReason: 'Failed hard guardrails: ' + this.formatGuardrailFailures(guardrails),
    });
  }

  private formatGuardrailFailures(g: GuardrailsCheck): string {
    const failures: string[] = [];
    if (g.invalid_choices > GATE_CONFIG.guardrails.max_invalid_choices) {
      failures.push(`invalid_choices=${g.invalid_choices}`);
    }
    if (g.crashes > GATE_CONFIG.guardrails.max_crashes) {
      failures.push(`crashes=${g.crashes}`);
    }
    if (g.timeouts > GATE_CONFIG.guardrails.max_timeouts) {
      failures.push(`timeouts=${g.timeouts}`);
    }
    if (g.p99_turn_time_ms > GATE_CONFIG.guardrails.max_p99_turn_time_ms) {
      failures.push(`p99=${g.p99_turn_time_ms.toFixed(0)}ms`);
    }
    if (g.fallback_rate > GATE_CONFIG.guardrails.max_fallback_rate) {
      failures.push(`fallback=${(g.fallback_rate * 100).toFixed(1)}%`);
    }
    if (g.state_mismatches > GATE_CONFIG.guardrails.max_state_mismatches) {
      failures.push(`mismatches=${g.state_mismatches}`);
    }
    return failures.join(', ');
  }

  private async recordResult(result: TournamentResult): Promise<void> {
    // Create Result node
    const resultNode = {
      id: `result-${result.challenger_id}-${Date.now()}`,
      type: 'Result' as const,
      status: 'done' as const,
      title: `Gate: ${result.verdict}`,
      description: result.reason,
      created_at: Date.now(),
      updated_at: Date.now(),
      metrics: {
        verdict: result.verdict,
        games: result.games.length,
        panel_results: result.panel_results,
        guardrails: result.guardrails,
        held_out: result.held_out,
        sprt_result: result.sprt_result,
        play: this.playSummary(result.challenger_id, result.games),
      },
    };

    this.db.addNode(resultNode);

    // Link result to experiment
    this.db.addEdge({
      id: `${result.challenger_id}-produced-${resultNode.id}`,
      from_node: result.challenger_id,
      to_node: resultNode.id,
      type: 'produced',
      created_at: Date.now(),
    });

    // If promoted, update champion and create supersede edge
    if (result.verdict === 'promoted') {
      this.db.updateNode(result.challenger_id, {
        status: 'done',
      });

      if (this.db.getNode(result.champion_id)) {
        this.db.updateNode(result.champion_id, { status: 'superseded' });
      }

      const vsRandom = result.panel_results.find(r => r.opponent.includes('random'));
      const vsMax = result.panel_results.find(r => r.opponent.includes('max'));
      const vsChampion = result.panel_results.find(r => r.opponent === result.champion_id);
      const blueprint = championBlueprint(result.challenger_id);
      const championNodeId = blueprint.id;
      this.db.addNode({
        id: championNodeId,
        type: 'Champion',
        status: 'active',
        title: blueprint.title,
        description: blueprint.description,
        created_at: Date.now(),
        updated_at: Date.now(),
        version: blueprint.version,
        config_path: blueprint.config_path,
        promoted_at: Date.now(),
        metrics: {
          win_rate_vs_random: vsRandom?.win_rate,
          win_rate_vs_maxdamage: vsMax?.win_rate,
          win_rate_vs_champion: vsChampion?.win_rate,
          invalid_choices: result.guardrails.invalid_choices,
          crashes: result.guardrails.crashes,
          timeouts: result.guardrails.timeouts,
          p99_turn_time_ms: result.guardrails.p99_turn_time_ms,
          fallback_rate: result.guardrails.fallback_rate,
          state_mismatches: result.guardrails.state_mismatches,
        },
      } as any);

      this.db.addEdge({
        id: `${championNodeId}-supersedes-${result.champion_id}`,
        from_node: championNodeId,
        to_node: result.champion_id,
        type: 'supersedes',
        created_at: Date.now(),
      });
      
      this.db.addEdge({
        id: `${result.challenger_id}-supersedes-${result.champion_id}`,
        from_node: result.challenger_id,
        to_node: result.champion_id,
        type: 'supersedes',
        created_at: Date.now(),
      });
    } else {
      // Rejected: mark experiment as rejected
      this.db.updateNode(result.challenger_id, {
        status: 'rejected',
      });
    }
  }
}
