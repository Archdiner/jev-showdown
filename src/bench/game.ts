import { PRNG, type PokemonSet } from '@pkmn/sim';
import { buildBot } from '../config/bot.js';
import type { BotSpec } from '../config/interfaces.js';
import { hazardScore } from '../config/layers/battle.js';
import {
  hpEval,
  legalChoices,
  safeChoose,
  startRandomBattle,
  type SideId,
} from '../engine/exact/battle-utils.js';

export interface GameJob {
  index: number;
  seed: number;
  p1Team: PokemonSet[];
  p2Team: PokemonSet[];
  p1: BotSpec;
  p2: BotSpec;
  logDecisions?: boolean;
  logProtocol?: boolean;
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
  crashed: boolean;
  error?: string;
  p1TurnTimes: number[];
  p2TurnTimes: number[];
  p1ConfigId: string;
  p2ConfigId: string;
  p1Situations: SideSituations;
  p2Situations: SideSituations;
  decisions?: Array<{ side: SideId; turn: number; choice: string; configId: string }>;
  log?: string;
}

const MAX_LOOPS = 800;

export async function runGame(job: GameJob): Promise<GameResult> {
  const rng = new PRNG([job.seed >>> 0, 3, 5, 7] as never);
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
    p1ConfigId: job.p1.configId,
    p2ConfigId: job.p2.configId,
    p1Situations: emptySituations(),
    p2Situations: emptySituations(),
    decisions: job.logDecisions ? [] : undefined,
  };
  const p1 = buildBot(job.p1);
  const p2 = buildBot(job.p2);
  const gameId = `${job.p1.configId}:${job.p2.configId}:${job.seed}:${job.index}`;
  p1.beginGame({ gameId, seed: job.seed, opponentConfigId: job.p2.configId });
  p2.beginGame({ gameId, seed: job.seed, opponentConfigId: job.p1.configId });
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
        result.error = `stuck at turn ${battle.turn}`;
        break;
      }
      if (p1Legal.length) {
        const decision = await p1.decide({ battle, side: 'p1', rng, gameId, seed: job.seed });
        result.p1TurnTimes.push(decision.ms);
        if (!p1Legal.includes(decision.choice) && decision.choice !== 'default') result.p1Invalid++;
        const ok = safeChoose(battle, 'p1', decision.choice);
        if (!ok) result.p1Invalid++;
        result.decisions?.push({ side: 'p1', turn: battle.turn, choice: decision.choice, configId: decision.configId });
      }
      if (!battle.ended && p2Legal.length) {
        const decision = await p2.decide({ battle, side: 'p2', rng, gameId, seed: job.seed });
        result.p2TurnTimes.push(decision.ms);
        if (!p2Legal.includes(decision.choice) && decision.choice !== 'default') result.p2Invalid++;
        const ok = safeChoose(battle, 'p2', decision.choice);
        if (!ok) result.p2Invalid++;
        result.decisions?.push({ side: 'p2', turn: battle.turn, choice: decision.choice, configId: decision.configId });
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

  p1.endGame({ winner: result.winner, turns: result.turns, invalid: result.p1Invalid, situations: { ...result.p1Situations } });
  p2.endGame({ winner: result.winner === 'p1' ? 'p2' : result.winner === 'p2' ? 'p1' : 'tie', turns: result.turns, invalid: result.p2Invalid, situations: { ...result.p2Situations } });
  return result;
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
