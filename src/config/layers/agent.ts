import type { Battle } from '@pkmn/sim';
import type { SideId } from '../../engine/exact/battle-utils.js';
import { register } from '../registry.js';
import { AgentParamsSchema, MACRO_STYLES, type AgentParams, type MacroStyle } from '../schema.js';
import type { GamePlan } from '../interfaces.js';

const NOTES: Record<MacroStyle, string> = {
  balanced: 'Keep a speed option and a win condition. Trade the rest.',
  'hyper-offense': 'Force progress. Spend tera and low-value mons to keep the win condition healthy.',
  attrition: 'Preserve the speed option and chip through hazards, status, and recovery.',
  'hazard-stack': 'Get hazards up early and punish switches.',
  'setup-sweeper': 'Find a safe turn to boost the win condition, then end the game.',
};

export interface AgentImpl {
  id: string;
  params: AgentParams;
  preview(battle: Battle, side: SideId): GamePlan | null;
}

export function registerAgents(): void {
  for (const style of MACRO_STYLES) {
    register<AgentParams>({
      layer: 'agent',
      id: style,
      schema: AgentParamsSchema,
      defaults: { style, preview: 'heuristic' },
      create: params => ({
        id: style,
        params,
        preview(battle: Battle, side: SideId): GamePlan | null {
          if (params.preview === 'off') return null;
          return heuristicPlan(battle, side, params.style);
        },
      }),
    });
  }
}

export function heuristicPlan(battle: Battle, side: SideId, style: MacroStyle): GamePlan {
  const mons = battle.getSide(side).pokemon.filter(mon => mon && !mon.fainted && mon.hp > 0);
  const bySpeed = [...mons].sort((a, b) => (b.storedStats?.spe || 0) - (a.storedStats?.spe || 0));
  const offense = (mon: typeof mons[number]) => Math.max(mon.storedStats?.atk || 0, mon.storedStats?.spa || 0);
  const byOffense = [...mons].sort((a, b) => offense(b) - offense(a));
  const speed = bySpeed[0]?.species?.name || 'unknown';
  const win = byOffense[0]?.species?.name || speed;
  const preserve = new Set<string>();
  if (style === 'hyper-offense' || style === 'setup-sweeper') preserve.add(win);
  else preserve.add(speed);
  if (style === 'attrition' || style === 'balanced') preserve.add(speed);
  if (style === 'hazard-stack') preserve.add(win);
  return {
    style,
    winCondition: win,
    preserve: [...preserve],
    notes: NOTES[style],
  };
}
