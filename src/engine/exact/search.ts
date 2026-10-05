import { Battle, PRNG } from '@pkmn/sim';
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
import { SearchProfile } from './config.js';
import switchProfile from '../../../experiments/switch-depth2/config.json' with { type: 'json' };
import { rankedSwitches } from './matchup.js';
import { pruneReplies, replyDistribution, WeightedChoice } from './switch-model.js';
import { teamEval } from './team-eval.js';
import { sampleWorlds, type WorldSample, type WorldEvidence } from './worlds.js';

export type { WorldEvidence };

export interface ExactConfig {
  depth: number;
  opponentModel: 'max-damage' | 'uniform' | 'switch';
  evalMode: 'hp' | 'full' | 'team';
  /**
   * Legacy bug: a branch whose choice the sim rejects is scored as a loss
   * instead of being ignored. The old search did this for every
   * "Not all choices done" reconstruction failure.
   */
  errorAsLoss: boolean;
  /**
   * Independent RNG draws averaged at the root. One draw treats an 80%
   * move as a hit or a miss; the average ranks it by how often it lands.
   */
  samples?: number;
  maxReplies?: number;
  minReplyProb?: number;
  /** Own actions below the root. The root always sees every legal switch. */
  deeperChoices?: number;
}

export const EXACT_1PLY: ExactConfig = {
  depth: 1,
  opponentModel: 'max-damage',
  evalMode: 'hp',
  errorAsLoss: false,
  samples: 8,
};

export const SWITCH_DEPTH2: ExactConfig = switchProfile as SearchProfile;

export interface ScoredChoice {
  choice: string;
  score: number;
}

export interface SearchTrace {
  choice: string;
  scores: ScoredChoice[];
  /** The switch model's most likely reply is a switch. */
  predictedSwitch?: boolean;
  /** Our choice is also the best answer to that switch. */
  answersPredictedSwitch?: boolean;
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

export function battleToState(battle: Battle, sideId: SideId): GameState {
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
    // Material is weighted by about 100, so a big lead outscores the
    // ±1000 terminal and search will refuse a winning move. Divide by
    // that weight so one mon of HP is O(1) and a finished game always wins.
    const raw = fullEvaluator.evaluate(battleToState(battle, sideId)).score;
    const unit = fullEvaluator.getWeights().material || 1;
    return raw / unit;
  }
  if (config.evalMode === 'team') return teamEval(battle, sideId);
  return hpEval(battle, sideId);
}

function opponentDistribution(battle: Battle, opp: SideId, config: ExactConfig): WeightedChoice[] {
  const legal = legalChoices(battle, opp);
  if (legal.length === 0) return [];
  if (config.opponentModel === 'switch') {
    return pruneReplies(
      replyDistribution(battle, opp, legal),
      config.maxReplies ?? 2,
      config.minReplyProb ?? 0,
    );
  }
  if (config.opponentModel === 'uniform') {
    return legal.map(choice => ({ choice, prob: 1 / legal.length }));
  }
  const moves = legal.filter(choice => choice.startsWith('move '));
  if (moves.length === 0) return [{ choice: legal[0], prob: 1 }];
  return [{ choice: maxDamageChoice(battle, opp, moves), prob: 1 }];
}

function ownChoices(battle: Battle, sideId: SideId, config: ExactConfig, atRoot: boolean): string[] {
  const legal = legalChoices(battle, sideId);
  const cap = config.deeperChoices ?? 0;
  if (atRoot || cap <= 0 || legal.length <= cap) return legal;
  const moves = legal.filter(choice => choice.startsWith('move '));
  const switches = rankedSwitches(battle, sideId).map(row => row.choice);
  const kept = [...moves];
  for (const choice of switches) {
    if (kept.length >= cap) break;
    if (!kept.includes(choice)) kept.push(choice);
  }
  if (kept.length === 0) return legal.slice(0, cap);
  return kept.slice(0, cap);
}

/**
 * 1-ply (or deeper) exact search.
 * Every branch is a clone of the real battle stepped with Battle.choose.
 */
export function exactSearch(battle: Battle, sideId: SideId, config: ExactConfig = EXACT_1PLY): SearchTrace {
  const mine = ownChoices(battle, sideId, config, true);
  if (mine.length === 0) return { choice: 'default', scores: [] };
  if (mine.length === 1) return { choice: mine[0], scores: [{ choice: mine[0], score: 0 }] };

  const snap = snapshot(battle);
  const replies = opponentDistribution(battle, otherSide(sideId), config);
  const switchReply = replies.find(reply => reply.choice.startsWith('switch')) || null;
  const modal = replies.reduce<WeightedChoice | null>((best, reply) => {
    if (!best || reply.prob > best.prob) return reply;
    return best;
  }, null);
  const predictedSwitch = Boolean(modal?.choice.startsWith('switch'));

  const scores: ScoredChoice[] = [];
  let best = mine[0];
  let bestScore = -Infinity;
  let answer = mine[0];
  let bestAgainstSwitch = -Infinity;

  for (const choice of mine) {
    const parts = scoreChoice(snap, sideId, choice, config.depth, config, config.samples ?? 1, replies, switchReply?.choice || null);
    scores.push({ choice, score: parts.mean });
    if (parts.mean > bestScore) {
      bestScore = parts.mean;
      best = choice;
    }
    if (parts.againstSwitch != null && parts.againstSwitch > bestAgainstSwitch) {
      bestAgainstSwitch = parts.againstSwitch;
      answer = choice;
    }
  }

  return {
    choice: best,
    scores,
    predictedSwitch,
    answersPredictedSwitch: predictedSwitch && best === answer,
  };
}

function reseed(battle: Battle, sample: number): void {
  const prng = new PRNG([sample + 1, 0x6d2b79f5, 0x1b873593, 0x85ebca6b] as any);
  battle.resetRNG(prng.startingSeed);
}

interface ChoiceScore {
  mean: number;
  againstSwitch: number | null;
}

function scoreChoice(
  snap: string,
  sideId: SideId,
  myChoice: string,
  depth: number,
  config: ExactConfig,
  samples: number,
  replies: WeightedChoice[] | null,
  switchReply: string | null,
): ChoiceScore {
  const root = cloneFromSnapshot(snap);
  const lines = replies ?? opponentDistribution(root, otherSide(sideId), config);
  const draws = Math.max(1, samples);
  const used = lines.length > 0 ? lines : [{ choice: '', prob: 1 }];
  let weighted = 0;
  let weight = 0;
  let againstSwitch: number | null = null;
  let switchWeight = 0;
  for (let sample = 0; sample < draws; sample++) {
    for (const reply of used) {
      const battle = cloneFromSnapshot(snap);
      reseed(battle, sample);
      const value = rollout(battle, sideId, myChoice, reply.choice || undefined, depth, config);
      weighted += reply.prob * value;
      weight += reply.prob;
      if (switchReply && reply.choice === switchReply) {
        againstSwitch = (againstSwitch ?? 0) + value;
        switchWeight++;
      }
    }
  }
  return {
    mean: weight > 0 ? weighted / weight : 0,
    againstSwitch: switchWeight > 0 && againstSwitch != null ? againstSwitch / switchWeight : null,
  };
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

  const next = ownChoices(battle, sideId, config, false);
  if (next.length === 0) return evaluate(battle, sideId, config);

  const snap = snapshot(battle);
  let best = -Infinity;
  for (const choice of next) {
    const score = scoreChoice(snap, sideId, choice, depth - 1, config, 1, null, null).mean;
    if (score > best) best = score;
  }
  return best;
}

/**
 * Determinized (sampled-world) exact search configuration.
 */
export interface DetConfig extends ExactConfig {
  /** Number of opponent worlds to sample. */
  worlds: number;
  /** How to aggregate scores across worlds. */
  aggregate: 'mean' | 'robust' | 'band75';
  /** For 'robust': mean - lambda * std. */
  robustLambda?: number;
}

export const EXACT_DET_1PLY: DetConfig = {
  ...EXACT_1PLY,
  samples: 2,
  worlds: 8,
  aggregate: 'mean',
};

export interface WorldTrace {
  tag: string;
  weight: number;
  best: string;
  bestScore: number;
}

export interface DetSearchTrace extends SearchTrace {
  /** Per-world details for logging. */
  worlds?: WorldTrace[];
  /** Worlds completed before deadline. */
  worldsCompleted?: number;
}

/**
 * Determinized exact search over sampled opponent worlds.
 * 
 * Samples K plausible opponent teams from randbats data conditioned on
 * revealed info, runs exact search in each world, and aggregates scores.
 */
export function determinizedSearch(
  evidence: WorldEvidence,
  buildBattle: (world: WorldSample) => Battle | null,
  sideId: SideId,
  cfg: DetConfig,
  stats: any,
  rng: PRNG,
): DetSearchTrace {
  const started = Date.now();
  const deadline = (cfg as any).deadlineMs ? started + (cfg as any).deadlineMs : Infinity;
  
  // Sample worlds
  const worlds = sampleWorlds(evidence, cfg.worlds, stats, rng);
  if (worlds.length === 0) {
    return { choice: 'default', scores: [], worldsCompleted: 0 };
  }
  
  // Score each choice across all worlds
  const perChoice = new Map<string, { scores: number[]; weights: number[] }>();
  const worldTraces: WorldTrace[] = [];
  let worldsCompleted = 0;
  
  for (const world of worlds) {
    if (Date.now() >= deadline) break;
    
    const battle = buildBattle(world);
    if (!battle) continue;
    
    const trace = exactSearch(battle, sideId, cfg);
    worldsCompleted++;
    
    worldTraces.push({
      tag: world.tag,
      weight: world.weight,
      best: trace.choice,
      bestScore: trace.scores.find(s => s.choice === trace.choice)?.score ?? 0,
    });
    
    for (const { choice, score } of trace.scores) {
      if (!perChoice.has(choice)) {
        perChoice.set(choice, { scores: [], weights: [] });
      }
      const entry = perChoice.get(choice)!;
      entry.scores.push(score);
      entry.weights.push(world.weight);
    }
  }
  
  if (perChoice.size === 0) {
    return { choice: 'default', scores: [], worldsCompleted, worlds: worldTraces };
  }
  
  // Aggregate scores
  const aggregated: ScoredChoice[] = [];
  for (const [choice, { scores, weights }] of perChoice.entries()) {
    const score = aggregateScore(scores, weights, cfg);
    aggregated.push({ choice, score });
  }
  
  aggregated.sort((a, b) => b.score - a.score);
  const best = aggregated[0];
  
  return {
    choice: best.choice,
    scores: aggregated,
    worldsCompleted,
    worlds: worldTraces,
  };
}

function aggregateScore(scores: number[], weights: number[], cfg: DetConfig): number {
  if (scores.length === 0) return -Infinity;
  
  // Normalize weights
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const normalized = totalWeight > 0 ? weights.map(w => w / totalWeight) : weights.map(() => 1 / weights.length);
  
  // Weighted mean
  const mean = scores.reduce((sum, score, i) => sum + score * normalized[i], 0);
  
  if (cfg.aggregate === 'robust') {
    const variance = scores.reduce(
      (sum, score, i) => sum + normalized[i] * Math.pow(score - mean, 2),
      0
    );
    const std = Math.sqrt(variance);
    const lambda = cfg.robustLambda ?? 0.5;
    return mean - lambda * std;
  }
  
  if (cfg.aggregate === 'band75') {
    // Foul Play style: uniform over choices within 75% of range
    // This is handled at the policy level, so just return mean here
    return mean;
  }
  
  return mean;
}
