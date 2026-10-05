import { Dex } from '@pkmn/dex';
import type { Battle, Pokemon } from '@pkmn/sim';
import { SideId, otherSide } from '../../engine/exact/battle-utils.js';

export function hpFrac(mon: Pokemon | null | undefined): number {
  if (!mon || !mon.maxhp) return 0;
  return Math.max(0, mon.hp) / mon.maxhp;
}

export function aliveCount(battle: Battle, side: SideId): number {
  return battle.getSide(side).pokemon.filter(mon => mon && !mon.fainted && mon.hp > 0).length;
}

export function boostSum(mon: Pokemon | null | undefined): number {
  if (!mon?.boosts) return 0;
  const keys = ['atk', 'def', 'spa', 'spd', 'spe'] as const;
  return keys.reduce((sum, key) => sum + Math.max(0, mon.boosts[key] || 0), 0);
}

export function hazardScore(battle: Battle, side: SideId): number {
  const conditions = battle.getSide(side).sideConditions as Record<string, { layers?: number } | undefined>;
  let score = 0;
  if (conditions.stealthrock) score += 1;
  if (conditions.spikes) score += 0.5 * (conditions.spikes.layers || 1);
  if (conditions.toxicspikes) score += 0.3 * (conditions.toxicspikes.layers || 1);
  if (conditions.stickyweb) score += 0.4;
  return score;
}

export function bestStat(battle: Battle, side: SideId, stat: 'spe' | 'atk' | 'spa'): number {
  let best = 0;
  for (const mon of battle.getSide(side).pokemon) {
    if (!mon || mon.fainted) continue;
    best = Math.max(best, mon.storedStats?.[stat] || 0);
  }
  return best;
}

export function moveOf(battle: Battle, side: SideId, choice: string): { id: string; basePower: number; priority: number; target: string; sideCondition?: string; category: string; boosts?: Record<string, number> } | null {
  if (!choice.startsWith('move ')) return null;
  const index = Number(choice.split(' ')[1]) - 1;
  const id = battle.getSide(side).active[0]?.moveSlots?.[index]?.id;
  if (!id) return null;
  const move = Dex.moves.get(id);
  if (!move.exists) return { id, basePower: 0, priority: 0, target: '', category: 'Status' };
  return {
    id: move.id,
    basePower: move.basePower || 0,
    priority: move.priority || 0,
    target: move.target,
    sideCondition: move.sideCondition || undefined,
    category: move.category,
    boosts: move.boosts as Record<string, number> | undefined,
  };
}

export function isHazardMove(move: { target: string; sideCondition?: string }): boolean {
  return move.target === 'foeSide' && Boolean(move.sideCondition);
}

export function isSetupMove(move: { target: string; boosts?: Record<string, number> }): boolean {
  return Boolean(move.boosts) && (move.target === 'self' || move.target === 'allySide');
}

export { otherSide };
