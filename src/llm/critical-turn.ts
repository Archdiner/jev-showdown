import { Battle } from '@pkmn/sim';
import type { SideId } from '../engine/exact/battle-utils.js';

/** Public board used to decide whether the plan is stale. */
export interface BoardSnap {
  turn: number;
  ourSpecies: string;
  foeSpecies: string;
  ourHp: number;
  foeHp: number;
  ourAlive: number;
  foeAlive: number;
  canTera: boolean;
}

export interface CriticalConfig {
  hpSwing: number;
  endgameMons: number;
}

export function readBoard(battle: Battle, side: SideId): BoardSnap {
  const me = battle.getSide(side);
  const foe = me.foe;
  const ours = me.active[0];
  const theirs = foe.active[0];
  const request = me.activeRequest as { active?: Array<{ canTerastallize?: unknown }> } | null;
  return {
    turn: battle.turn,
    ourSpecies: ours?.species?.name || '',
    foeSpecies: theirs?.species?.name || '',
    ourHp: hpFrac(ours),
    foeHp: hpFrac(theirs),
    ourAlive: alive(me.pokemon),
    foeAlive: alive(foe.pokemon),
    canTera: Boolean(request?.active?.[0]?.canTerastallize),
  };
}

/**
 * Reasons the cached plan is stale.
 * Endgame and Terastallize fire on the transition, not on every later turn.
 * An empty `prev` is the start of the game.
 */
export function criticalReasons(prev: BoardSnap | null, now: BoardSnap, cfg: CriticalConfig): string[] {
  if (!prev) return ['start'];
  const reasons: string[] = [];
  if (now.turn <= 1 && prev.turn !== now.turn) reasons.push('start');
  if (now.foeSpecies !== prev.foeSpecies) reasons.push('new-foe');
  if (now.ourAlive < prev.ourAlive || now.foeAlive < prev.foeAlive) reasons.push('ko');
  if (now.foeSpecies === prev.foeSpecies && delta(now.foeHp, prev.foeHp) >= cfg.hpSwing) reasons.push('hp-swing');
  if (now.ourSpecies === prev.ourSpecies && delta(now.ourHp, prev.ourHp) >= cfg.hpSwing) reasons.push('hp-swing');
  if (now.canTera && !prev.canTera) reasons.push('tera');
  const wasEnd = prev.ourAlive <= cfg.endgameMons || prev.foeAlive <= cfg.endgameMons;
  const isEnd = now.ourAlive <= cfg.endgameMons || now.foeAlive <= cfg.endgameMons;
  if (isEnd && !wasEnd) reasons.push('endgame');
  return [...new Set(reasons)];
}

export function activeKey(snap: BoardSnap): string {
  return `${snap.ourSpecies}|${snap.foeSpecies}`;
}

function alive(pokemon: Array<{ fainted?: boolean; hp: number }>): number {
  return pokemon.filter(mon => !mon.fainted && mon.hp > 0).length;
}

function hpFrac(mon: { hp: number; maxhp: number } | null | undefined): number {
  if (!mon || mon.maxhp <= 0) return 0;
  return Math.max(0, mon.hp) / mon.maxhp;
}

function delta(next: number, prev: number): number {
  return Math.abs(next - prev);
}
