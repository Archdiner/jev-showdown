import { PRNG, type PokemonSet } from '@pkmn/sim';
import { buildBot } from '../config/bot.js';
import type { BotSpec } from '../config/interfaces.js';
import { isBotSpec } from '../config/load.js';
import { hazardScore } from '../config/layers/battle.js';
import {
  hpEval,
  isPlayableChoice,
  legalChoices,
  safeChoose,
  startRandomBattle,
  type SideId,
} from '../engine/exact/battle-utils.js';
import { informationMode, ladderDecisionBattle, type InformationMode } from '../client/hidden-info.js';
import { decide, type PolicySpec } from '../engine/exact/policies.js';

/** A config bot (buildBot) or an engine policy (exact / switch / random). */
export type BenchPlayer = BotSpec | PolicySpec;

export interface GameJob {
  index: number;
  seed: number;
  p1Team: PokemonSet[];
  p2Team: PokemonSet[];
  p1: BenchPlayer;
  p2: BenchPlayer;
  logDecisions?: boolean;
  logProtocol?: boolean;
  /**
   * `hidden` (the default) is the ladder client: each side searches only what
   * a Showdown request and the public protocol would show. `full` is the old
   * omniscient battle. `JEV_INFORMATION` sets the default when this is omitted.
   */
  information?: InformationMode;
}

export interface SideSituations {
  leading: number;
  trailing: number;
  endgame1v1: boolean;
  endgame2v2: boolean;
  hazardAdvantage: boolean;
  hazardDisadvantage: boolean;
  weather: boolean;
  teraFirst: boolean;
  teraSecond: boolean;
}

export interface GameResult {
  index: number;
  seed: number;
  winner: 'p1' | 'p2' | 'tie';
  turns: number;
  p1Invalid: number;
  p2Invalid: number;
  /** Hidden-info rebuilds that failed, so the side played its first legal choice. */
  p1ViewMiss: number;
  p2ViewMiss: number;
  information: InformationMode;
  crashed: boolean;
  error?: string;
  p1TurnTimes: number[];
  p2TurnTimes: number[];
  p1ConfigId: string;
  p2ConfigId: string;
  p1Situations: SideSituations;
  p2Situations: SideSituations;
  p1Decisions: number;
  p1Switches: number;
  p1Predicted: number;
  p1Answered: number;
  p1LlmCostUsd: number;
  p1Timeouts: number;
  p2LlmCostUsd: number;
  p2Timeouts: number;
  p2Decisions: number;
  p2Switches: number;
  p2Predicted: number;
  p2Answered: number;
  decisions?: Array<{
    side: SideId;
    turn: number;
    choice: string;
    configId: string;
    scores?: Array<{ choice: string; score: number }>;
  }>;
  log?: string;
}

const MAX_LOOPS = 800;

export function playerId(player: BenchPlayer): string {
  if (isBotSpec(player)) return player.configId;
  return `policy:${JSON.stringify(player)}`;
}

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

interface Opened {
  id: string;
  bot?: ReturnType<typeof buildBot>;
  policy?: PolicySpec;
}

function openPlayer(player: BenchPlayer): Opened {
  if (isBotSpec(player)) return { id: player.configId, bot: buildBot(player) };
  return { id: playerId(player), policy: player };
}

export async function runGame(job: GameJob): Promise<GameResult> {
  const rng = new PRNG([job.seed >>> 0, 3, 5, 7] as never);
  const p1 = openPlayer(job.p1);
  const p2 = openPlayer(job.p2);
  const result: GameResult = {
    index: job.index,
    seed: job.seed,
    winner: 'tie',
    turns: 0,
    p1Invalid: 0,
    p2Invalid: 0,
    p1ViewMiss: 0,
    p2ViewMiss: 0,
    information: informationMode(job.information),
    crashed: false,
    p1TurnTimes: [],
    p2TurnTimes: [],
    p1ConfigId: p1.id,
    p2ConfigId: p2.id,
    p1Situations: emptySituations(),
    p2Situations: emptySituations(),
    p1Decisions: 0,
    p1Switches: 0,
    p1Predicted: 0,
    p1Answered: 0,
    p1LlmCostUsd: 0,
    p1Timeouts: 0,
    p2LlmCostUsd: 0,
    p2Timeouts: 0,
    p2Decisions: 0,
    p2Switches: 0,
    p2Predicted: 0,
    p2Answered: 0,
    decisions: job.logDecisions ? [] : undefined,
  };
  const gameId = `${p1.id}:${p2.id}:${job.seed}:${job.index}`;
  p1.bot?.beginGame({ gameId, seed: job.seed, opponentConfigId: p2.id });
  p2.bot?.beginGame({ gameId, seed: job.seed, opponentConfigId: p1.id });
  let teraFirst: SideId | null = null;

  try {
    const battle = startRandomBattle(job.p1Team, job.p2Team, job.seed);
    let loops = 0;
    while (!battle.ended && loops < MAX_LOOPS) {
      loops++;
      observe(battle, result, teraFirst);
      teraFirst = noteTera(battle, teraFirst, result);
      const p1Legal = legalChoices(battle, 'p1');
      const p2Legal = legalChoices(battle, 'p2');
      if (p1Legal.length === 0 && p2Legal.length === 0) {
        result.crashed = true;
        result.error = `stuck at turn ${battle.turn} request=${battle.requestState}`;
        break;
      }
      if (p1Legal.length) {
        const decision = await chooseSeen(p1, battle, 'p1', rng, gameId, job.seed, result.information, p1Legal);
        if (decision.viewMiss) result.p1ViewMiss++;
        result.p1TurnTimes.push(decision.ms);
        notePlay(result, 'p1', p1Legal, decision);
        if (!isPlayableChoice(battle, 'p1', decision.choice) && decision.choice !== 'default') result.p1Invalid++;
        const ok = safeChoose(battle, 'p1', decision.choice);
        if (!ok) result.p1Invalid++;
        result.decisions?.push({
          side: 'p1',
          turn: battle.turn,
          choice: decision.choice,
          configId: decision.configId,
          scores: decision.scores,
        });
      }
      if (!battle.ended && p2Legal.length) {
        const decision = await chooseSeen(p2, battle, 'p2', rng, gameId, job.seed, result.information, p2Legal);
        if (decision.viewMiss) result.p2ViewMiss++;
        result.p2TurnTimes.push(decision.ms);
        notePlay(result, 'p2', p2Legal, decision);
        if (!isPlayableChoice(battle, 'p2', decision.choice) && decision.choice !== 'default') result.p2Invalid++;
        const ok = safeChoose(battle, 'p2', decision.choice);
        if (!ok) result.p2Invalid++;
        result.decisions?.push({
          side: 'p2',
          turn: battle.turn,
          choice: decision.choice,
          configId: decision.configId,
          scores: decision.scores,
        });
      }
    }
    result.turns = battle.turn;
    if (battle.winner === 'P1') result.winner = 'p1';
    else if (battle.winner === 'P2') result.winner = 'p2';
    else result.winner = 'tie';
    if (loops >= MAX_LOOPS && !battle.ended) {
      result.winner = 'tie';
      result.error = 'decision cap';
    }
    if (job.logProtocol) result.log = battle.log.join('\n');
  } catch (error) {
    result.crashed = true;
    result.error = error instanceof Error ? error.message : String(error);
  }

  const p1Metrics = p1.bot?.metrics?.() ?? { llmCostUsd: 0, timeouts: 0 };
  const p2Metrics = p2.bot?.metrics?.() ?? { llmCostUsd: 0, timeouts: 0 };
  result.p1LlmCostUsd = p1Metrics.llmCostUsd;
  result.p1Timeouts = p1Metrics.timeouts;
  result.p2LlmCostUsd = p2Metrics.llmCostUsd;
  result.p2Timeouts = p2Metrics.timeouts;
  p1.bot?.endGame({ winner: result.winner, turns: result.turns, invalid: result.p1Invalid, situations: { ...result.p1Situations } });
  p2.bot?.endGame({
    winner: result.winner === 'p1' ? 'p2' : result.winner === 'p2' ? 'p1' : 'tie',
    turns: result.turns,
    invalid: result.p2Invalid,
    situations: { ...result.p2Situations },
  });
  return result;
}

async function chooseSeen(
  player: Opened,
  battle: Parameters<typeof legalChoices>[0],
  side: SideId,
  rng: PRNG,
  gameId: string,
  seed: number,
  information: InformationMode,
  legal: string[],
): Promise<Awaited<ReturnType<typeof choose>> & { viewMiss?: boolean }> {
  if (information === 'full') return choose(player, battle, side, rng, gameId, seed);
  if (legal.length === 1 && legal[0] === 'default') {
    return { choice: 'default', ms: 0, configId: player.id };
  }
  const viewed = ladderDecisionBattle(battle, side);
  if (!viewed) return { choice: legal[0] || 'default', ms: 0, configId: player.id, viewMiss: true };
  return choose(player, viewed, 'p1', rng, gameId, seed);
}

async function choose(
  player: Opened,
  battle: Parameters<typeof legalChoices>[0],
  side: SideId,
  rng: PRNG,
  gameId: string,
  seed: number,
): Promise<{
  choice: string;
  ms: number;
  configId: string;
  scores?: Array<{ choice: string; score: number }>;
  predictedSwitch?: boolean;
  answersPredictedSwitch?: boolean;
}> {
  if (player.policy) {
    const decision = await decide(player.policy, battle, side, rng);
    return { ...decision, configId: player.id };
  }
  const decision = await player.bot!.decide({ battle, side, rng, gameId, seed });
  return decision;
}

function emptySituations(): SideSituations {
  return {
    leading: 0,
    trailing: 0,
    endgame1v1: false,
    endgame2v2: false,
    hazardAdvantage: false,
    hazardDisadvantage: false,
    weather: false,
    teraFirst: false,
    teraSecond: false,
  };
}

function observe(battle: Parameters<typeof hpEval>[0], result: GameResult, teraFirst: SideId | null): void {
  for (const side of ['p1', 'p2'] as const) {
    const sit = side === 'p1' ? result.p1Situations : result.p2Situations;
    const score = hpEval(battle, side);
    if (score > 0.5) sit.leading++;
    else if (score < -0.5) sit.trailing++;
    const mine = battle.getSide(side).pokemon.filter(mon => !mon.fainted && mon.hp > 0).length;
    const foeSide: SideId = side === 'p1' ? 'p2' : 'p1';
    const foe = battle.getSide(foeSide).pokemon.filter(mon => !mon.fainted && mon.hp > 0).length;
    if (mine === 1 && foe === 1) sit.endgame1v1 = true;
    if (mine <= 2 && foe <= 2) sit.endgame2v2 = true;
    const mineHazards = hazardScore(battle, side);
    const foeHazards = hazardScore(battle, foeSide);
    if (foeHazards > mineHazards) sit.hazardAdvantage = true;
    if (mineHazards > foeHazards) sit.hazardDisadvantage = true;
    if ((battle.field as { weather?: string }).weather) sit.weather = true;
    if (teraFirst === side) sit.teraFirst = true;
    if (teraFirst && teraFirst !== side) sit.teraSecond = true;
  }
}

function noteTera(battle: Parameters<typeof hpEval>[0], current: SideId | null, result: GameResult): SideId | null {
  if (current) return current;
  for (const side of ['p1', 'p2'] as const) {
    if (battle.getSide(side).pokemon.some(mon => Boolean((mon as { terastallized?: string }).terastallized))) {
      const sit = side === 'p1' ? result.p1Situations : result.p2Situations;
      sit.teraFirst = true;
      return side;
    }
  }
  return null;
}
