import { Battle } from '@pkmn/sim';
import { Evaluator } from '../evaluator.js';
import { GameState } from '../../types/index.js';
import {
  SideId,
  cloneFromSnapshot,
  hpEval,
  legalChoices,
  otherSide,
  playChoices,
  snapshot,
} from './battle-utils.js';
import { maxDamageChoice } from './max-damage.js';

export interface ExactConfig {
  depth: number;
  opponentModel: 'max-damage' | 'uniform';
  evalMode: 'hp' | 'full';
  /**
   * Legacy bug: a branch whose choice the sim rejects is scored as a loss
   * instead of being ignored. The old search did this for every
   * "Not all choices done" reconstruction failure.
   */
  errorAsLoss: boolean;
}

export const EXACT_1PLY: ExactConfig = {
  depth: 1,
  opponentModel: 'max-damage',
  evalMode: 'hp',
  errorAsLoss: false,
};

export interface ScoredChoice {
  choice: string;
  score: number;
}

export interface SearchTrace {
  choice: string;
  scores: ScoredChoice[];
}

const fullEvaluator = new Evaluator();

function beliefFrom(pokemon: any) {
  const stats = pokemon.baseStoredStats || pokemon.storedStats || {};
  return {
    species: pokemon.species?.name || 'Unknown',
    level: pokemon.level,
    possibleSets: new Map<string, number>(),
    revealedMoves: new Set<string>(pokemon.moveSlots?.map((m: any) => m.id) || []),
    revealedAbility: pokemon.ability,
    revealedItem: pokemon.item,
    stats: {
      hp: pokemon.maxhp,
      atk: stats.atk || 0,
      def: stats.def || 0,
      spa: stats.spa || 0,
      spd: stats.spd || 0,
      spe: stats.spe || 0,
    },
    currentHp: pokemon.hp,
    maxHp: pokemon.maxhp,
    status: pokemon.status || undefined,
  };
}

function battleToState(battle: Battle, sideId: SideId): GameState {
  const me = battle.getSide(sideId);
  const foe = me.foe;
  const myActive = Math.max(0, me.pokemon.findIndex(p => p.isActive));
  const oppActive = Math.max(0, foe.pokemon.findIndex(p => p.isActive));
  return {
    myTeam: me.pokemon.map(beliefFrom),
    opponentTeam: foe.pokemon.map(beliefFrom),
    myActive,
    opponentActive: oppActive,
    turn: battle.turn,
    myTeraUsed: false,
    opponentTeraUsed: false,
    field: { trickRoom: false, screens: {} },
    hazards: {
      my: { stealthRock: false, spikes: 0, toxicSpikes: 0 },
      opponent: { stealthRock: false, spikes: 0, toxicSpikes: 0 },
    },
    playerId: sideId,
  };
}

function evaluate(battle: Battle, sideId: SideId, config: ExactConfig): number {
  if (battle.ended && battle.winner) {
    const me = battle.getSide(sideId);
    return battle.winner === me.name ? 1000 : -1000;
  }
  if (config.evalMode === 'full') {
    return fullEvaluator.evaluate(battleToState(battle, sideId)).score;
  }
  return hpEval(battle, sideId);
}

function opponentLines(battle: Battle, opp: SideId, config: ExactConfig): string[] {
  const legal = legalChoices(battle, opp);
  if (legal.length === 0) return [];
  if (config.opponentModel === 'uniform') return legal;
  const moves = legal.filter(choice => choice.startsWith('move '));
  if (moves.length === 0) return legal;
  return [maxDamageChoice(battle, opp, moves)];
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

/**
 * 1-ply (or deeper) exact search.
 * Every branch is a clone of the real battle stepped with Battle.choose.
 */
export function exactSearch(battle: Battle, sideId: SideId, config: ExactConfig = EXACT_1PLY): SearchTrace {
  const mine = legalChoices(battle, sideId);
  if (mine.length === 0) return { choice: 'default', scores: [] };
  if (mine.length === 1) return { choice: mine[0], scores: [{ choice: mine[0], score: 0 }] };

  const snap = snapshot(battle);
  const scores: ScoredChoice[] = [];
  let best = mine[0];
  let bestScore = -Infinity;

  for (const choice of mine) {
    const score = scoreChoice(snap, battle, sideId, choice, config.depth, config);
    scores.push({ choice, score });
    if (score > bestScore) {
      bestScore = score;
      best = choice;
    }
  }

  return { choice: best, scores };
}

function scoreChoice(
  snap: string,
  live: Battle,
  sideId: SideId,
  myChoice: string,
  depth: number,
  config: ExactConfig,
): number {
  const root = snap ? cloneFromSnapshot(snap) : live;
  const opp = otherSide(sideId);
  const lines = opponentLines(root, opp, config);
  if (lines.length === 0) {
    return rollout(root, sideId, myChoice, undefined, depth, config);
  }
  const values = lines.map(oppChoice => rollout(cloneFromSnapshot(snap), sideId, myChoice, oppChoice, depth, config));
  return average(values);
}

function rollout(
  battle: Battle,
  sideId: SideId,
  myChoice: string,
  oppChoice: string | undefined,
  depth: number,
  config: ExactConfig,
): number {
  const ok = playChoices(battle, sideId, myChoice, oppChoice);
  if (!ok) {
    return config.errorAsLoss ? -10000 : evaluate(battle, sideId, config);
  }
  if (battle.ended || depth <= 1) return evaluate(battle, sideId, config);

  const next = legalChoices(battle, sideId);
  if (next.length === 0) return evaluate(battle, sideId, config);

  const snap = snapshot(battle);
  let best = -Infinity;
  for (const choice of next) {
    const score = scoreChoice(snap, battle, sideId, choice, depth - 1, config);
    if (score > best) best = score;
  }
  return best;
}
