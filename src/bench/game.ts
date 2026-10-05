import { PRNG } from '@pkmn/sim';
import { PolicySpec, decide } from '../engine/exact/policies.js';
import { PokemonSet } from '@pkmn/sim';
import {
  SideId,
  commitChoice,
  legalChoices,
  startRandomBattle,
} from '../engine/exact/battle-utils.js';
import { clearMatchupCache } from '../engine/exact/matchup.js';

export interface GameJob {
  index: number;
  seed: number;
  p1Team: PokemonSet[];
  p2Team: PokemonSet[];
  p1: PolicySpec;
  p2: PolicySpec;
  logDecisions?: boolean;
}

export interface GameResult {
  index: number;
  seed: number;
  winner: 'p1' | 'p2' | 'tie';
  turns: number;
  p1Invalid: number;
  p2Invalid: number;
  crashed: boolean;
  error?: string;
  p1TurnTimes: number[];
  p2TurnTimes: number[];
  p1Decisions: number;
  p1Switches: number;
  p1Predicted: number;
  p1Answered: number;
  p2Decisions: number;
  p2Switches: number;
  p2Predicted: number;
  p2Answered: number;
  decisions?: Array<{ side: SideId; turn: number; choice: string; scores?: Array<{ choice: string; score: number }> }>;
}

const MAX_LOOPS = 800;

function notePlay(
  result: GameResult,
  side: SideId,
  legal: string[],
  decision: { choice: string; predictedSwitch?: boolean; answersPredictedSwitch?: boolean },
): void {
  const voluntary = legal.some(choice => choice.startsWith('move'));
  if (!voluntary) return;
  if (side === 'p1') {
    result.p1Decisions++;
    if (decision.choice.startsWith('switch')) result.p1Switches++;
    if (decision.predictedSwitch) {
      result.p1Predicted++;
      if (decision.answersPredictedSwitch) result.p1Answered++;
    }
  } else {
    result.p2Decisions++;
    if (decision.choice.startsWith('switch')) result.p2Switches++;
    if (decision.predictedSwitch) {
      result.p2Predicted++;
      if (decision.answersPredictedSwitch) result.p2Answered++;
    }
  }
}

export async function runGame(job: GameJob): Promise<GameResult> {
  const rng = new PRNG([job.seed >>> 0, 3, 5, 7] as any);
  const result: GameResult = {
    index: job.index,
    seed: job.seed,
    winner: 'tie',
    turns: 0,
    p1Invalid: 0,
    p2Invalid: 0,
    crashed: false,
    p1TurnTimes: [],
    p2TurnTimes: [],
    p1Decisions: 0,
    p1Switches: 0,
    p1Predicted: 0,
    p1Answered: 0,
    p2Decisions: 0,
    p2Switches: 0,
    p2Predicted: 0,
    p2Answered: 0,
    decisions: job.logDecisions ? [] : undefined,
  };

  const started = Date.now();
  let loops = 0;
  let repeatedTurn = 0;
  let seenTurn = -1;
  clearMatchupCache();
  try {
    const battle = startRandomBattle(job.p1Team, job.p2Team, job.seed);
    while (!battle.ended && loops < MAX_LOOPS) {
      loops++;
      if (battle.turn === seenTurn) repeatedTurn++;
      else {
        seenTurn = battle.turn;
        repeatedTurn = 0;
      }
      // A request we cannot answer used to be retried until the decision cap,
      // and every retry was counted as an invalid choice.
      if (repeatedTurn > 8) {
        result.crashed = true;
        result.error = `turn ${battle.turn} did not advance request=${battle.requestState}`;
        break;
      }
      // Both players choose before either choice is sent. Choosing p1
      // first used to leave that move on the battle, and p2's search
      // then treated a simultaneous turn as a known opponent move.
      const planned: Array<{ side: SideId; legal: string[]; decision: Awaited<ReturnType<typeof decide>> }> = [];
      for (const side of ['p1', 'p2'] as const) {
        const legal = legalChoices(battle, side);
        if (legal.length === 0) continue;
        planned.push({ side, legal, decision: await decide(side === 'p1' ? job.p1 : job.p2, battle, side, rng) });
      }
      if (planned.length === 0) {
        result.crashed = true;
        result.error = `stuck at turn ${battle.turn} request=${battle.requestState}`;
        break;
      }

      for (const { side, legal, decision } of planned) {
        if (battle.ended) break;
        const times = side === 'p1' ? result.p1TurnTimes : result.p2TurnTimes;
        times.push(decision.ms);
        notePlay(result, side, legal, decision);
        const accepted = commitChoice(battle, side, decision.choice);
        if (!accepted) {
          if (side === 'p1') result.p1Invalid++;
          else result.p2Invalid++;
        }
        if (side === 'p1' && job.logDecisions && result.decisions && result.winner === 'tie') {
          result.decisions.push({ side: 'p1', turn: battle.turn, choice: decision.choice, scores: decision.scores });
        }
      }
    }

    result.turns = battle.turn;
    if (battle.winner === 'P1') result.winner = 'p1';
    else if (battle.winner === 'P2') result.winner = 'p2';
    else result.winner = 'tie';
    // A long stall that hits the decision cap is a tie, not a crash.
    if (loops >= MAX_LOOPS && !battle.ended) {
      result.winner = 'tie';
      result.error = 'decision cap';
    }
  } catch (error) {
    result.crashed = true;
    result.error = error instanceof Error ? error.message : String(error);
  }

  const elapsed = Date.now() - started;
  if (elapsed > 20000) {
    console.error(`slow game seed=${job.seed} turns=${result.turns} loops=${loops} ms=${elapsed} winner=${result.winner} err=${result.error || ''}`);
  }
  return result;
}
