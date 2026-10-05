import { Battle, Dex, PRNG } from '@pkmn/sim';
import {
  SideId,
  cloneFromSnapshot,
  hpEval,
  legalChoices,
  otherSide,
  playChoices,
  snapshot,
} from '../engine/exact/battle-utils.js';
import { maxDamageChoice } from '../engine/exact/max-damage.js';
import { featureVector, switchFeatureInput } from '../engine/exact/matchup.js';
import { switchProbability } from '../engine/exact/switch-model.js';

const STATUS: Record<string, number> = { brn: 0.35, par: 0.3, psn: 0.22, tox: 0.45, slp: 0.65, frz: 0.65 };

export interface SimScore {
  choice: string;
  score: number;
}

export interface Veto {
  from: string;
  to: string;
  gap: number;
  margin: number;
}

/**
 * Value after the simulator has applied the turn.
 * The extra ply after status, setup, and Protect is what makes those
 * moves worth more than zero damage. The status and boost terms only break ties.
 */
export function simValue(battle: Battle, sideId: SideId): number {
  let score = hpEval(battle, sideId);
  const me = battle.getSide(sideId);
  for (const mon of me.pokemon) score += monTerm(mon, 1);
  for (const mon of me.foe.pokemon) score += monTerm(mon, -1);
  return score;
}

function monTerm(mon: { fainted: boolean; hp: number; boosts: { atk?: number; def?: number; spa?: number; spd?: number; spe?: number }; status?: string }, sign: number): number {
  if (mon.fainted || mon.hp <= 0) return 0;
  const boosts = mon.boosts || {};
  const offense = (boosts.atk || 0) + (boosts.spa || 0) + (boosts.spe || 0);
  const defense = (boosts.def || 0) + (boosts.spd || 0);
  return sign * (0.05 * offense + 0.03 * defense) - sign * (STATUS[mon.status || ''] ?? 0);
}

export function vetoChoice(args: {
  proposal: string | null;
  scores: SimScore[];
  margin: number;
  legal: string[];
}): { choice: string; veto: Veto | null; fallback: boolean } {
  const ranked = [...args.scores].sort((a, b) => b.score - a.score || a.choice.localeCompare(b.choice));
  const best = ranked[0];
  if (!best) return { choice: args.legal[0] ?? 'default', veto: null, fallback: true };
  if (!args.proposal || !args.legal.includes(args.proposal)) {
    return { choice: best.choice, veto: null, fallback: true };
  }
  const proposed = ranked.find(row => row.choice === args.proposal);
  if (!proposed) return { choice: best.choice, veto: null, fallback: true };
  const gap = best.score - proposed.score;
  if (gap > args.margin) {
    return {
      choice: best.choice,
      fallback: false,
      veto: { from: args.proposal, to: best.choice, gap, margin: args.margin },
    };
  }
  return { choice: args.proposal, veto: null, fallback: false };
}

/** Score every legal choice, then keep a proposal unless the sim line is better by more than `margin`. */
export function simVeto(battle: Battle, sideId: SideId, margin = 1): {
  choice: string;
  veto: Veto | null;
  fallback: boolean;
  scores: SimScore[];
} {
  const scores = verifyChoices(battle, sideId);
  const moves = scores.map(row => row.choice).filter(choice => choice.startsWith('move ') && !choice.includes('terastallize'));
  const proposal = moves.length > 0 ? maxDamageChoice(battle, sideId, moves) : null;
  const decided = vetoChoice({ proposal, scores, margin, legal: scores.map(row => row.choice) });
  return { ...decided, scores };
}

export function verifyChoices(battle: Battle, sideId: SideId): SimScore[] {
  const legal = withTera(battle, sideId);
  if (legal.length === 0) return [];
  if (legal.every(choice => choice.startsWith('switch '))) {
    return legal
      .map(choice => ({ choice, score: scoreSwitch(battle, sideId, choice) }))
      .sort((a, b) => b.score - a.score || a.choice.localeCompare(b.choice));
  }

  const opp = otherSide(sideId);
  let pSwitch = 0;
  try {
    const features = featureVector(switchFeatureInput(battle, opp));
    pSwitch = legalChoices(battle, opp).some(choice => choice.startsWith('switch ')) ? switchProbability(features) : 0;
  } catch {
    pSwitch = 0;
  }
  const replies = opponentReplies(battle, opp, pSwitch);
  const snap = snapshot(battle);
  const scores: SimScore[] = [];
  for (const choice of legal) {
    const follow = needsFollow(moveAt(battle, sideId, choice));
    let total = 0;
    let weight = 0;
    for (const reply of replies) {
      const next = cloneFromSnapshot(snap);
      reseed(next, 1);
      const ok = playChoices(next, sideId, choice, reply.choice);
      if (ok && follow) continueOnce(next, sideId);
      const value = ok ? simValue(next, sideId) : simValue(battle, sideId);
      total += value * reply.weight;
      weight += reply.weight;
    }
    scores.push({ choice, score: weight > 0 ? total / weight : simValue(battle, sideId) });
  }
  scores.sort((a, b) => b.score - a.score || a.choice.localeCompare(b.choice));
  return scores;
}

function withTera(battle: Battle, sideId: SideId): string[] {
  const base = legalChoices(battle, sideId);
  const request = battle.getSide(sideId).activeRequest as { active?: Array<{ canTerastallize?: unknown }> } | null;
  if (!request?.active?.[0]?.canTerastallize) return base;
  return [...base, ...base.filter(choice => choice.startsWith('move ')).map(choice => `${choice} terastallize`)];
}

function opponentReplies(battle: Battle, opp: SideId, pSwitch: number): Array<{ choice: string; weight: number }> {
  const legal = legalChoices(battle, opp);
  const moves = legal.filter(choice => choice.startsWith('move '));
  const switches = legal.filter(choice => choice.startsWith('switch '));
  const attack = moves.length > 0 ? maxDamageChoice(battle, opp, moves) : null;
  const rows: Array<{ choice: string; weight: number }> = [];
  const stay = switches.length > 0 ? 1 - pSwitch : 1;
  if (attack) rows.push({ choice: attack, weight: stay });
  if (switches.length > 0 && pSwitch > 0) rows.push({ choice: bestSwitch(battle, opp, switches), weight: pSwitch });
  if (rows.length === 0 && legal[0]) rows.push({ choice: legal[0], weight: 1 });
  const total = rows.reduce((sum, row) => sum + row.weight, 0) || 1;
  return rows.map(row => ({ ...row, weight: row.weight / total }));
}

function bestSwitch(battle: Battle, sideId: SideId, switches: string[]): string {
  let best = switches[0];
  let bestScore = -Infinity;
  for (const choice of switches) {
    const score = scoreSwitch(battle, sideId, choice);
    if (score > bestScore) {
      bestScore = score;
      best = choice;
    }
  }
  return best;
}

function scoreSwitch(battle: Battle, sideId: SideId, choice: string): number {
  const next = cloneFromSnapshot(snapshot(battle));
  try {
    if (!next.choose(sideId, choice)) return -Infinity;
  } catch {
    return -Infinity;
  }
  continueOnce(next, otherSide(sideId));
  return simValue(next, sideId);
}

function continueOnce(battle: Battle, sideId: SideId): void {
  if (battle.ended) return;
  const opp = otherSide(sideId);
  const mine = legalChoices(battle, sideId).filter(choice => choice.startsWith('move '));
  const theirs = legalChoices(battle, opp).filter(choice => choice.startsWith('move '));
  if (mine.length === 0 && theirs.length === 0) return;
  playChoices(
    battle,
    sideId,
    mine.length ? maxDamageChoice(battle, sideId, mine) : undefined,
    theirs.length ? maxDamageChoice(battle, opp, theirs) : undefined,
  );
}

function needsFollow(moveName: string | null): boolean {
  if (!moveName) return false;
  const move = Dex.moves.get(moveName);
  if (!move.exists) return false;
  if (move.category === 'Status') return true;
  if (move.boosts && Object.values(move.boosts).some(stage => (stage ?? 0) > 0)) return true;
  return false;
}

function moveAt(battle: Battle, sideId: SideId, choice: string): string | null {
  if (!choice.startsWith('move ')) return null;
  const index = Number(choice.split(' ')[1]) - 1;
  return battle.getSide(sideId).active[0]?.moveSlots?.[index]?.move || null;
}

function reseed(battle: Battle, sample: number): void {
  battle.resetRNG(new PRNG([sample + 1, 0x6d2b79f5, 0x1b873593, 0x85ebca6b] as any).startingSeed);
}
