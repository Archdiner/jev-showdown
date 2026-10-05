import { Battle } from '@pkmn/sim';
import type { SideId } from '../engine/exact/battle-utils.js';
import { readBoard, type BoardSnap } from './critical-turn.js';
import type { SimScore } from './sim-veto.js';

interface SwitchTrace extends BoardSnap {
  streak: number;
  recent: string[];
}

const traces = new WeakMap<Battle, Map<SideId, SwitchTrace>>();

export interface SwitchState {
  streak: number;
  progress: boolean;
  recent: string[];
}

/** Consecutive switches that left the foe's active, faints, and HP essentially unchanged. */
export function switchState(battle: Battle, side: SideId, progressHp = 0.15): SwitchState {
  const prev = traces.get(battle)?.get(side);
  if (!prev) return { streak: 0, progress: true, recent: [] };
  const now = readBoard(battle, side);
  const progress = madeProgress(prev, now, progressHp);
  return { streak: progress ? 0 : prev.streak, progress, recent: prev.recent };
}

export function noteSwitchChoice(battle: Battle, side: SideId, choice: string, progressHp = 0.15): void {
  const state = switchState(battle, side, progressHp);
  const now = readBoard(battle, side);
  const switching = choice.startsWith('switch ');
  const streak = switching ? (state.progress ? 1 : state.streak + 1) : 0;
  save(battle, side, {
    ...now,
    streak,
    recent: [...state.recent, choice].slice(-6),
  });
}

/**
 * Flat cost on every switch while a no-progress streak is running.
 * One pivot stays inside the veto margin. A repeated switch falls behind a move
 * unless the sim lead is larger than the cost, which is what a faint is worth.
 */
export function penalizeSwitchScores(
  scores: SimScore[],
  streak: number,
  progress: boolean,
  cost: number,
): SimScore[] {
  if (progress || streak <= 0 || cost <= 0) return scores;
  if (scores.every(row => row.choice.startsWith('switch '))) return scores;
  const penalty = cost * streak;
  return scores.map(row => (
    row.choice.startsWith('switch ') ? { ...row, score: row.score - penalty } : row
  ));
}

/** Value-scale cost so Jev's own pick stops offering the loop. */
export function switchValueCost(choice: string, streak: number, progress: boolean): number {
  if (progress || streak <= 0 || !choice.startsWith('switch ')) return 0;
  return Math.min(0.75, 0.2 * streak);
}

export function switchHistoryText(state: SwitchState): string {
  const recent = state.recent.length ? state.recent.join(', ') : 'none';
  return `SWITCH HISTORY consecutive=${state.streak} progress=${state.progress ? 'yes' : 'no'} recent=${recent}`;
}

function madeProgress(prev: SwitchTrace, now: BoardSnap, progressHp: number): boolean {
  if (now.foeSpecies !== prev.foeSpecies) return true;
  if (now.foeAlive < prev.foeAlive) return true;
  if (prev.foeHp - now.foeHp >= progressHp) return true;
  return false;
}

function save(battle: Battle, side: SideId, trace: SwitchTrace): void {
  let bySide = traces.get(battle);
  if (!bySide) {
    bySide = new Map();
    traces.set(battle, bySide);
  }
  bySide.set(side, trace);
}
