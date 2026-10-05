import type { Battle } from '@pkmn/sim';
import { legalChoices, type SideId } from '../../engine/exact/battle-utils.js';
import { maxDamageChoice } from '../../engine/exact/max-damage.js';
import { register } from '../registry.js';
import { PolicyParamsSchema, type PolicyParams } from '../schema.js';
import type { GamePlan, PolicyEffect } from '../interfaces.js';
import { aliveCount, boostSum, hpFrac, isHazardMove, isSetupMove, moveOf, otherSide } from './battle.js';

export const POLICY_LAYERS = [
  'teraPolicy',
  'hazardPolicy',
  'sacPolicy',
  'switchPolicy',
  'leadPolicy',
  'endgamePolicy',
] as const;
export type PolicyLayer = (typeof POLICY_LAYERS)[number];

export interface PolicyView {
  battle: Battle;
  side: SideId;
  legal: string[];
  plan: GamePlan | null;
}

export interface PolicyImpl {
  apply(view: PolicyView): PolicyEffect;
}

export function registerPolicies(): void {
  for (const layer of POLICY_LAYERS) {
    register<PolicyParams>({
      layer,
      id: 'off',
      schema: PolicyParamsSchema,
      defaults: { enabled: false },
      create: () => ({ apply: () => ({}) }),
    });
    register<PolicyParams>({
      layer,
      id: 'heuristic',
      schema: PolicyParamsSchema,
      defaults: { enabled: true },
      create: params => ({
        apply: (view: PolicyView) => (params.enabled ? applyLayer(layer, view) : {}),
      }),
    });
  }
}

function applyLayer(layer: PolicyLayer, view: PolicyView): PolicyEffect {
  if (layer === 'endgamePolicy') return endgame(view);
  if (layer === 'sacPolicy') return sac(view);
  if (layer === 'switchPolicy') return switchOut(view);
  if (layer === 'teraPolicy') return tera(view);
  if (layer === 'hazardPolicy') return biasMoves(view, (move, choice, bias) => {
    if (isHazardMove(move) && !alreadySet(view, move.sideCondition)) bias[choice] = (bias[choice] || 0) + 40;
  });
  return lead(view);
}

function endgame(view: PolicyView): PolicyEffect {
  if (aliveCount(view.battle, view.side) !== 1 || aliveCount(view.battle, otherSide(view.side)) !== 1) return {};
  const moves = view.legal.filter(choice => choice.startsWith('move '));
  if (moves.length === 0) return {};
  const choice = maxDamageChoice(view.battle, view.side, moves);
  return view.legal.includes(choice) ? { override: choice } : {};
}

function sac(view: PolicyView): PolicyEffect {
  const active = view.battle.getSide(view.side).active[0];
  if (!active) return {};
  const name = active.species?.name || '';
  const preserved = view.plan?.preserve.includes(name) ?? false;
  const hp = hpFrac(active);
  const switches = view.legal.filter(choice => choice.startsWith('switch '));
  if (preserved && hp < 0.35 && switches.length > 0) return { override: switches[0] };
  if (!preserved && hp < 0.25 && switches.length > 0) {
    const bias: Record<string, number> = {};
    for (const choice of switches) bias[choice] = -30;
    return { bias };
  }
  return {};
}

function switchOut(view: PolicyView): PolicyEffect {
  const foe = view.battle.getSide(otherSide(view.side)).active[0];
  if (boostSum(foe) < 2) return {};
  const bias: Record<string, number> = {};
  for (const choice of view.legal) {
    if (choice.startsWith('switch ')) bias[choice] = 35;
  }
  return { bias };
}

function tera(view: PolicyView): PolicyEffect {
  const active = view.battle.getSide(view.side).active[0];
  if (!active || hpFrac(active) >= 0.45) return {};
  let best = '';
  let power = -1;
  for (const choice of view.legal) {
    const move = moveOf(view.battle, view.side, choice);
    if (move && move.basePower > power) {
      power = move.basePower;
      best = choice;
    }
  }
  if (!best || power <= 0) return {};
  return { bias: { [best]: 15 } };
}

function lead(view: PolicyView): PolicyEffect {
  if ((view.battle.turn || 0) > 1) return {};
  return biasMoves(view, (move, choice, bias) => {
    if (isHazardMove(move) && !alreadySet(view, move.sideCondition)) bias[choice] = (bias[choice] || 0) + 30;
    if (isSetupMove(move)) bias[choice] = (bias[choice] || 0) + 20;
  });
}

function biasMoves(
  view: PolicyView,
  apply: (move: NonNullable<ReturnType<typeof moveOf>>, choice: string, bias: Record<string, number>) => void
): PolicyEffect {
  const bias: Record<string, number> = {};
  for (const choice of view.legal) {
    const move = moveOf(view.battle, view.side, choice);
    if (move) apply(move, choice, bias);
  }
  return Object.keys(bias).length ? { bias } : {};
}

function alreadySet(view: PolicyView, condition: string | undefined): boolean {
  if (!condition) return false;
  const conditions = view.battle.getSide(otherSide(view.side)).sideConditions as Record<string, unknown>;
  return Boolean(conditions?.[condition]);
}

export function legalOrEmpty(battle: Battle, side: SideId): string[] {
  return legalChoices(battle, side);
}
