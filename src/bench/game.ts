import { PRNG } from '@pkmn/sim';
import { PolicySpec, decide } from '../engine/exact/policies.js';
import { PokemonSet } from '@pkmn/sim';
import {
  SideId,
  legalChoices,
  safeChoose,
  startRandomBattle,
} from '../engine/exact/battle-utils.js';

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

  try {
    const battle = startRandomBattle(job.p1Team, job.p2Team, job.seed);
    let loops = 0;
    while (!battle.ended && loops < MAX_LOOPS) {
      loops++;
      const p1Legal = legalChoices(battle, 'p1');
      const p2Legal = legalChoices(battle, 'p2');
      if (p1Legal.length === 0 && p2Legal.length === 0) {
        result.crashed = true;
        result.error = `stuck at turn ${battle.turn} request=${battle.requestState}`;
        break;
      }

      if (p1Legal.length) {
        const decision = await decide(job.p1, battle, 'p1', rng);
        result.p1TurnTimes.push(decision.ms);
        notePlay(result, 'p1', p1Legal, decision);
        if (!p1Legal.includes(decision.choice)) result.p1Invalid++;
        const ok = safeChoose(battle, 'p1', decision.choice);
        if (!ok) result.p1Invalid++;
        if (job.logDecisions && result.decisions && result.winner === 'tie') {
          result.decisions.push({ side: 'p1', turn: battle.turn, choice: decision.choice, scores: decision.scores });
        }
      }
      if (!battle.ended && p2Legal.length) {
        const decision = await decide(job.p2, battle, 'p2', rng);
        result.p2TurnTimes.push(decision.ms);
        notePlay(result, 'p2', p2Legal, decision);
        if (!p2Legal.includes(decision.choice)) result.p2Invalid++;
        const ok = safeChoose(battle, 'p2', decision.choice);
        if (!ok) result.p2Invalid++;
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

  return result;
}
