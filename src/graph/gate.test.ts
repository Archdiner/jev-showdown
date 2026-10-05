import { EXACT_1PLY } from '../engine/exact/search.js';
import {
  decidePromotion,
  gateOpponents,
  GATE_CONFIG,
  guardrailsFor,
  heldOutPlan,
  scoreAgainst,
  sprtDecision,
  type GameResult,
  type GuardrailsCheck,
  type PanelResult,
} from './gate.js';

function metrics(crashes = 0) {
  return {
    invalid_choices: 0,
    crashes,
    timeouts: 0,
    turn_times_ms: [10],
    fallback_rate: 0,
    state_mismatches: 0,
    eval_swings: [],
  };
}

function game(winner: GameResult['winner'], p1: string, p2: string, crashes = 0): GameResult {
  return {
    winner,
    p1,
    p2,
    seed: 1,
    turns: 1,
    protocol_log: '',
    p1_metrics: metrics(crashes),
    p2_metrics: metrics(0),
  };
}

const openGuardrails: GuardrailsCheck = {
  passed: true,
  invalid_choices: 0,
  crashes: 0,
  timeouts: 0,
  p99_turn_time_ms: 10,
  fallback_rate: 0,
  state_mismatches: 0,
};

function randomWin(): PanelResult {
  return {
    opponent: 'random-v1',
    challenger_elo: 1800,
    champion_elo: 1500,
    elo_diff: 300,
    win_rate: 0.9,
    ci_lower: 0.8,
    ci_upper: 0.95,
    games: 300,
    significant_improvement: true,
    significant_regression: false,
  };
}

describe('graph gate SPRT', () => {
  test('the champion id is played, and beating random is not a promotion', () => {
    expect(gateOpponents('champion-exact-1ply')).toContain('champion-exact-1ply');
    expect(gateOpponents('random-v1')).toEqual(GATE_CONFIG.panel);

    const early = sprtDecision(117, 33);
    expect(early.decision).toBe('continue');
    expect(early.llr).toBeCloseTo(2.356, 2);
    expect(early.elo0).toBe(0);
    expect(early.elo1).toBe(10);
    expect(sprtDecision(0, 0).decision).toBe('continue');
    expect(sprtDecision(250, 100).decision).toBe('accept_h1');
    expect(sprtDecision(100, 250).decision).toBe('accept_h0');

    const heldOut = { ok: true, reason: 'held-out ok' };
    const beatingRandom = decidePromotion({
      championId: 'champion-exact-1ply',
      panelResults: [randomWin()],
      guardrails: openGuardrails,
      heldOut,
      championWins: 0,
      championLosses: 0,
    });
    expect(beatingRandom.verdict).toBe('rejected');
    expect(beatingRandom.sprt_result.decision).toBe('continue');

    const promoted = decidePromotion({
      championId: 'champion-exact-1ply',
      panelResults: [randomWin()],
      guardrails: openGuardrails,
      heldOut,
      championWins: 250,
      championLosses: 100,
    });
    expect(promoted.verdict).toBe('promoted');
    expect(promoted.sprt_result.decision).toBe('accept_h1');

    const worse = decidePromotion({
      championId: 'champion-exact-1ply',
      panelResults: [randomWin()],
      guardrails: openGuardrails,
      heldOut,
      championWins: 100,
      championLosses: 250,
    });
    expect(worse.verdict).toBe('rejected');
    expect(worse.sprt_result.decision).toBe('accept_h0');
  });

  test('a tie is half a win and a crash fails the guardrail', () => {
    expect(scoreAgainst('challenger', [game('tie', 'challenger', 'champion-exact-1ply')])).toEqual({
      wins: 0.5,
      losses: 0.5,
      games: 1,
    });
    const crashed = guardrailsFor('challenger', [game('p1', 'challenger', 'champion-exact-1ply', 1)]);
    expect(crashed.crashes).toBe(1);
    expect(crashed.passed).toBe(false);
    const blocked = decidePromotion({
      championId: 'champion-exact-1ply',
      panelResults: [randomWin()],
      guardrails: crashed,
      heldOut: { ok: true, reason: 'held-out ok' },
      championWins: 250,
      championLosses: 100,
    });
    expect(blocked.verdict).toBe('rejected');
  });

  test('held-out does not score a non-exact challenger as the default 1-ply', () => {
    expect(heldOutPlan('random-v1').ok).toBe(false);
    const exact = heldOutPlan('exact-1ply');
    expect(exact.ok).toBe(true);
    if (exact.ok) expect(exact.config).toEqual(EXACT_1PLY);
  });
});
