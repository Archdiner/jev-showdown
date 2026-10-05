import { Battle, PRNG } from '@pkmn/sim';
import { Evaluator } from '../evaluator.js';
import { GameState } from '../../types/index.js';
import {
  SideId,
  cloneFromSnapshot,
  hpEval,
  legalChoices,
  moveSlotIndex,
  otherSide,
  playChoices,
  snapshot,
} from './battle-utils.js';
import { expectedDamage, maxDamageChoice } from './max-damage.js';
import { SearchProfile } from './config.js';
import switchProfile from '../../../experiments/switch-depth2/config.json' with { type: 'json' };
import { rankedSwitches } from './matchup.js';
import { koProbability } from './ko-groups.js';
import { applyFoePrior, progressPenalty } from './public.js';
import { applyStatsPrior, foeHiddenOf, type StatsPriorOptions } from './stats-prior.js';
import { pruneReplies, replyDistribution, WeightedChoice } from './switch-model.js';
import { teamEval } from './team-eval.js';
import { fittedTeamEval } from './fitted-eval.js';
import { selectiveDepth2 } from './depth2.js';
import { createHash } from 'crypto';

export interface SelectiveOptions {
  /** Root moves, ranked by depth 1, that receive a depth-2 look. */
  topN: number;
  /** Opponent replies kept under each of those moves. */
  topM: number;
}

export interface ExactConfig {
  depth: number;
  opponentModel: 'max-damage' | 'uniform' | 'switch';
  evalMode: 'hp' | 'full' | 'team' | 'fitted';
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
  /** Stop once this time has passed and at least one score exists. Absolute clock. */
  deadlineMs?: number;
  /**
   * Milliseconds from the start of this search. Used when the caller has no
   * absolute deadline. The config layer passes deadlineMs instead.
   */
  budgetMs?: number;
  /** Group each damaging move's roll chart into KO and non-KO. */
  rollGrouping?: 'sample' | 'ko';
  /** When set at depth >= 2, exactSearch runs selective depth-2. */
  selective?: SelectiveOptions;
  /**
   * Keep this many damage-ranked replies for max-damage and uniform.
   * The switch model keeps using maxReplies.
   */
  replyCap?: number;
  /**
   * Leaf override for a config evaluator that is not one of the built-in
   * modes. Only selective-depth2 sets this. Unset leaves the built-in eval.
   */
  leaf?: (battle: Battle, side: SideId) => number;
  /**
   * When set, a depth-2 rollout stops at deadlineMs. Existing depth-n
   * searches leave this unset and finish the node, matching main.
   */
  rolloutDeadline?: boolean;
  /** Search `move N terastallize` whenever the request still allows it. */
  tera?: boolean;
  /**
   * Demote immune attacks, Choice locks a revealed bench walls, and
   * status moves when the foe's current moves KO us before we move.
   */
  progress?: boolean;
  /**
   * Fill an incomplete foe movepool from one randbats set before the
   * rollout. A four-move set is left as it is.
   */
  foePrior?: boolean;
  /**
   * With foePrior: fill the foe from the randbats usage posterior instead of
   * the first matching set (opt-in; see stats-prior.ts).
   */
  statsPrior?: StatsPriorOptions;
  /**
   * Opt-in endgame deepening: search `depth` plies (with rollouts bound by
   * the deadline) once at most `mons` unfainted mons remain on both sides
   * combined. Unset keeps the configured depth everywhere.
   */
  endgame?: EndgameOptions;
}

export interface EndgameOptions {
  /** Deepen when our unfainted mons + the foe's not-yet-fainted mons <= this. */
  mons: number;
  /** Depth used in the endgame. */
  depth: number;
}

/** Gen 9 Random Battle teams always have six mons; unrevealed foes are alive. */
const RANDBATS_TEAM_SIZE = 6;

/**
 * Mons still in the game from the searching side's view. Our side counts
 * unfainted mons. The decision battle may hold only the revealed foes, so
 * the foe count is the team size minus the foes seen to faint.
 */
export function remainingMons(battle: Battle, sideId: SideId): number {
  const me = battle.getSide(sideId);
  const ours = me.pokemon.filter(mon => !mon.fainted && mon.hp > 0).length;
  const foeTeam = Math.max(RANDBATS_TEAM_SIZE, me.foe.pokemon.length);
  const foeFainted = me.foe.pokemon.filter(mon => mon.fainted || mon.hp <= 0).length;
  return ours + Math.max(0, foeTeam - foeFainted);
}

/** The config this decision searches with: deeper when the endgame option fires. */
export function endgameConfig(battle: Battle, sideId: SideId, config: ExactConfig): ExactConfig {
  const endgame = config.endgame;
  if (!endgame || endgame.depth <= config.depth) return config;
  if (remainingMons(battle, sideId) > endgame.mons) return config;
  return { ...config, depth: endgame.depth, rolloutDeadline: true };
}

/** True when the deadline has passed and the search already has a score to return. */
export function searchBudgetExpired(deadlineMs: number | undefined, scored: number): boolean {
  return deadlineMs != null && scored > 0 && Date.now() >= deadlineMs;
}

/** Live champion. Same fields as main. Quick wins are `EXACT_1PLY_QW`. */
export const EXACT_1PLY: ExactConfig = {
  depth: 1,
  opponentModel: 'max-damage',
  evalMode: 'hp',
  errorAsLoss: false,
  samples: 8,
};

/**
 * Ladder-loss quick wins: terastallize, skip immune and Choice locks, fill a
 * hidden foe. Not the champion. Policy id `EXACT_1PLY_QW`.
 */
export const EXACT_1PLY_QW: ExactConfig = {
  depth: 1,
  opponentModel: 'max-damage',
  evalMode: 'hp',
  errorAsLoss: false,
  samples: 8,
  tera: true,
  progress: true,
  foePrior: true,
};

/** specFromId / factory evidence name for the quick-win policy. */
export const QUICK_WIN_POLICY_ID = 'EXACT_1PLY_QW';
/** Config-layer search id used by configs/exact-1ply-qw.yaml. */
export const QUICK_WIN_SEARCH_ID = 'exact-1ply-qw';

/** Exact 1-ply with the fitted team eval. Same samples and opponent model as EXACT_1PLY. */
export const FITTED_1PLY: ExactConfig = {
  ...EXACT_1PLY,
  evalMode: 'fitted',
};

/**
 * Selective depth-2 with the fitted eval. Top 3 depth-1 moves, top 2 replies,
 * KO/non-KO roll groups, 400ms budget. The config id `selective-depth2` is the
 * same search with the caller's deadline.
 */
export const FITTED_DEPTH2: ExactConfig = {
  depth: 2,
  opponentModel: 'max-damage',
  evalMode: 'fitted',
  errorAsLoss: false,
  samples: 1,
  rollGrouping: 'ko',
  selective: { topN: 3, topM: 2 },
  deeperChoices: 3,
  budgetMs: 400,
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
  /** 1 when the deadline stopped the search before a depth-2 replacement. */
  depthReached?: number;
  /** Transposition hits inside this decision. */
  cacheHits?: number;
  transpositionSize?: number;
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
  if (config.leaf) return config.leaf(battle, sideId);
  if (config.evalMode === 'fitted') return fittedTeamEval(battle, sideId);
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
  const legal = legalChoices(battle, opp).filter(choice => !choice.includes('terastallize'));
  if (legal.length === 0) return [];
  if (config.opponentModel === 'switch') {
    return pruneReplies(
      replyDistribution(battle, opp, legal),
      config.maxReplies ?? 2,
      config.minReplyProb ?? 0,
    );
  }
  if ((config.replyCap ?? 0) > 1) {
    const ranked = replyWeights(battle, opp, legal).slice(0, config.replyCap);
    const total = ranked.reduce((sum, row) => sum + row.weight, 0);
    if (ranked.length === 0) return [];
    if (total <= 0) {
      const prob = 1 / ranked.length;
      return ranked.map(row => ({ choice: row.choice, prob }));
    }
    return ranked.map(row => ({ choice: row.choice, prob: row.weight / total }));
  }
  if (config.opponentModel === 'uniform') {
    return legal.map(choice => ({ choice, prob: 1 / legal.length }));
  }
  const moves = legal.filter(choice => choice.startsWith('move '));
  if (moves.length === 0) return [{ choice: legal[0], prob: 1 }];
  return [{ choice: maxDamageChoice(battle, opp, moves), prob: 1 }];
}

/**
 * The opponent action this config assumes for one turn.
 * `sideId` is our side. The string is a sim choice (`move 1`, `switch 2`).
 */
export function modalReply(battle: Battle, sideId: SideId, config: ExactConfig): string | null {
  const replies = opponentDistribution(battle, otherSide(sideId), config);
  let best: WeightedChoice | null = null;
  for (const reply of replies) {
    if (!reply.choice) continue;
    if (!best || reply.prob > best.prob) best = reply;
  }
  return best?.choice ?? null;
}

/** Same seed the search uses for draw `sample` (0 is the first draw). */
export function reseed(battle: Battle, sample: number): void {
  const prng = new PRNG([sample + 1, 0x6d2b79f5, 0x1b873593, 0x85ebca6b] as any);
  battle.resetRNG(prng.startingSeed);
}

function ownChoices(battle: Battle, sideId: SideId, config: ExactConfig, atRoot: boolean): string[] {
  const legal = legalChoices(battle, sideId, { tera: atRoot && config.tera === true });
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
  if (config.endgame) config = endgameConfig(battle, sideId, config);
  if (config.selective && config.depth >= 2) return selectiveDepth2(battle, sideId, config);
  const working = config.foePrior ? withFoePrior(battle, sideId, config.statsPrior) : battle;
  const mine = ownChoices(working, sideId, config, true);
  if (mine.length === 0) return { choice: 'default', scores: [] };
  if (mine.length === 1) return { choice: mine[0], scores: [{ choice: mine[0], score: 0 }] };

  const snap = snapshot(working);
  const replies = opponentDistribution(working, otherSide(sideId), config);
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
    if (searchBudgetExpired(config.deadlineMs, scores.length)) break;
    const parts = scoreChoice(snap, sideId, choice, config.depth, config, config.samples ?? 1, replies, switchReply?.choice || null);
    const score = parts.mean - (config.progress ? progressPenalty(working, sideId, choice) : 0);
    scores.push({ choice, score });
    if (score > bestScore) {
      bestScore = score;
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

function withFoePrior(battle: Battle, sideId: SideId, statsPrior?: StatsPriorOptions): Battle {
  const clone = cloneFromSnapshot(snapshot(battle));
  if (statsPrior) {
    // Hidden marks index p2 of the decision battle (our side is p1 there).
    const hidden = otherSide(sideId) === 'p2' ? foeHiddenOf(battle) : undefined;
    applyStatsPrior(clone, sideId, hidden, statsPrior);
  } else {
    applyFoePrior(clone, sideId);
  }
  return clone;
}

export interface ChoiceScore {
  mean: number;
  againstSwitch: number | null;
  /** False when the deadline expired before any line was played. */
  played: boolean;
}

export function scoreLine(
  snap: string,
  sideId: SideId,
  myChoice: string,
  depth: number,
  config: ExactConfig,
  samples: number,
  replies: WeightedChoice[] | null,
  switchReply: string | null,
): ChoiceScore {
  return scoreChoice(snap, sideId, myChoice, depth, config, samples, replies, switchReply);
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
  if (config.rollGrouping === 'ko') {
    return scoreGrouped(snap, sideId, myChoice, depth, config, replies, switchReply);
  }
  const root = cloneFromSnapshot(snap);
  const lines = replies ?? opponentDistribution(root, otherSide(sideId), config);
  const draws = Math.max(1, samples);
  const used = lines.length > 0 ? lines : [{ choice: '', prob: 1 }];
  let weighted = 0;
  let weight = 0;
  let againstSwitch: number | null = null;
  let switchWeight = 0;
  for (let sample = 0; sample < draws; sample++) {
    if (searchBudgetExpired(config.deadlineMs, weight)) break;
    for (const reply of used) {
      if (searchBudgetExpired(config.deadlineMs, weight)) break;
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
    played: weight > 0,
  };
}

const PROBE_SEEDS = 10;

function scoreGrouped(
  snap: string,
  sideId: SideId,
  myChoice: string,
  depth: number,
  config: ExactConfig,
  replies: WeightedChoice[] | null,
  switchReply: string | null,
): ChoiceScore {
  const root = cloneFromSnapshot(snap);
  const lines = replies ?? opponentDistribution(root, otherSide(sideId), config);
  const used = lines.length > 0 ? lines : [{ choice: '', prob: 1 }];
  let weighted = 0;
  let weight = 0;
  let againstSwitch: number | null = null;
  let switchWeight = 0;
  for (const reply of used) {
    if (searchBudgetExpired(config.deadlineMs, weight)) break;
    const value = groupedValue(snap, sideId, myChoice, reply.choice, depth, config);
    weighted += reply.prob * value;
    weight += reply.prob;
    if (switchReply && reply.choice === switchReply) {
      againstSwitch = (againstSwitch ?? 0) + value;
      switchWeight++;
    }
  }
  return {
    mean: weight > 0 ? weighted / weight : 0,
    againstSwitch: switchWeight > 0 && againstSwitch != null ? againstSwitch / switchWeight : null,
    played: weight > 0,
  };
}

function groupedValue(
  snap: string,
  sideId: SideId,
  myChoice: string,
  oppChoice: string,
  depth: number,
  config: ExactConfig,
): number {
  const probe = cloneFromSnapshot(snap);
  const pKo = koProbability(probe, sideId, myChoice);
  const play = (sample: number) => {
    const battle = cloneFromSnapshot(snap);
    reseed(battle, sample);
    const foeSide = otherSide(sideId);
    const foe = battle.getSide(foeSide).active[0];
    const ident = foe?.fullname || '';
    const hpBefore = foe?.hp ?? 0;
    const value = rollout(battle, sideId, myChoice, oppChoice || undefined, depth, config);
    const after = ident
      ? battle.getSide(foeSide).pokemon.find(mon => mon.fullname === ident)
      : undefined;
    const ko = hpBefore > 0 && (!after || after.fainted || after.hp <= 0);
    return { value, ko };
  };
  if (pKo == null || pKo <= 0 || pKo >= 1) {
    return play(0).value;
  }
  let koValue: number | null = null;
  let liveValue: number | null = null;
  for (let sample = 0; sample < PROBE_SEEDS && (koValue == null || liveValue == null); sample++) {
    const found = (koValue == null ? 0 : 1) + (liveValue == null ? 0 : 1);
    if (searchBudgetExpired(config.deadlineMs, found)) break;
    const outcome = play(sample);
    if (outcome.ko && koValue == null) koValue = outcome.value;
    if (!outcome.ko && liveValue == null) liveValue = outcome.value;
  }
  if (koValue == null && liveValue == null) return play(0).value;
  if (koValue == null) return liveValue as number;
  if (liveValue == null) return koValue;
  return pKo * koValue + (1 - pKo) * liveValue;
}

interface TranspositionTable {
  values: Map<string, number>;
  hits: number;
}

let table: TranspositionTable | null = null;

/** One transposition table for a decision. Nested searches share it. */
export function withTranspositions<T>(fn: () => T): T {
  const outer = table;
  if (!outer) table = { values: new Map(), hits: 0 };
  try {
    return fn();
  } finally {
    if (!outer) table = null;
  }
}

export function transpositionStats(): { hits: number; size: number } {
  if (!table) return { hits: 0, size: 0 };
  return { hits: table.hits, size: table.values.size };
}

function positionKey(battle: Battle, sideId: SideId, depth: number, config: ExactConfig): string {
  const hash = createHash('sha1');
  hash.update(snapshot(battle));
  hash.update(`|${sideId}|${depth}|${config.evalMode}|${config.rollGrouping || ''}|${config.replyCap || 0}`);
  return hash.digest('hex');
}

function remember(key: string | null, value: number): void {
  if (key && table) table.values.set(key, value);
}

function recall(key: string | null): number | undefined {
  if (!key || !table) return undefined;
  const hit = table.values.get(key);
  if (hit === undefined) return undefined;
  table.hits++;
  return hit;
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
  if (battle.ended) return evaluate(battle, sideId, config);

  const key = table ? positionKey(battle, sideId, depth, config) : null;
  const cached = recall(key);
  if (cached !== undefined) return cached;

  if (depth <= 1) {
    const value = evaluate(battle, sideId, config);
    remember(key, value);
    return value;
  }

  const next = ownChoices(battle, sideId, config, false);
  if (next.length === 0) {
    const value = evaluate(battle, sideId, config);
    remember(key, value);
    return value;
  }

  const snap = snapshot(battle);
  let best = -Infinity;
  let scored = 0;
  let complete = true;
  for (const choice of next) {
    if (config.rolloutDeadline && searchBudgetExpired(config.deadlineMs, scored)) {
      complete = false;
      break;
    }
    const score = scoreChoice(snap, sideId, choice, depth - 1, config, 1, null, null).mean;
    scored++;
    if (score > best) best = score;
  }
  const value = scored > 0 ? best : evaluate(battle, sideId, config);
  if (complete) remember(key, value);
  return value;
}

function replyWeights(battle: Battle, side: SideId, choices: string[]): Array<{ choice: string; weight: number }> {
  const attacker = battle.getSide(side).active[0];
  const defender = battle.getSide(side).foe.active[0];
  const weather = (battle.field as { weather?: { id?: string } }).weather?.id;
  const scored = choices.map(choice => {
    if (!choice.startsWith('move ') || !attacker || !defender) return { choice, weight: 0.05 };
    const index = moveSlotIndex(choice);
    const moveId = attacker.moveSlots[index]?.id;
    if (!moveId) return { choice, weight: 0.05 };
    return { choice, weight: Math.max(0, expectedDamage(attacker, defender, moveId, weather)) };
  });
  scored.sort((a, b) => b.weight - a.weight || a.choice.localeCompare(b.choice));
  return scored;
}
