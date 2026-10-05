import type { Battle } from '@pkmn/sim';
import type { SideId } from '../../engine/exact/battle-utils.js';
import { register } from '../registry.js';
import { MetaParamsSchema, type MetaParams } from '../schema.js';
import { aliveCount, boostSum, hazardScore, otherSide } from './battle.js';

export interface MetaView {
  battle: Battle;
  side: SideId;
  rating?: number;
}

export interface MetaAdjustment {
  agentId?: string;
  searchDepth?: number;
}

export interface MetaImpl {
  id: string;
  params: MetaParams;
  select(view: MetaView): MetaAdjustment;
}

export function registerMeta(): void {
  register<MetaParams>({
    layer: 'metaController',
    id: 'static',
    schema: MetaParamsSchema,
    defaults: MetaParamsSchema.parse({}),
    create: params => ({ id: 'static', params, select: () => ({}) }),
  });
  register<MetaParams>({
    layer: 'metaController',
    id: 'phase',
    schema: MetaParamsSchema,
    defaults: MetaParamsSchema.parse({}),
    create: params => ({
      id: 'phase',
      params,
      select(view: MetaView): MetaAdjustment {
        const phase = phaseOf(view, params);
        const patch = params.phases[phase];
        return patch ? { agentId: patch.agentId, searchDepth: patch.searchDepth } : {};
      },
    }),
  });
  register<MetaParams>({
    layer: 'metaController',
    id: 'archetype',
    schema: MetaParamsSchema,
    defaults: MetaParamsSchema.parse({}),
    create: params => ({
      id: 'archetype',
      params,
      select(view: MetaView): MetaAdjustment {
        const patch = params.archetypes[archetypeOf(view)];
        return patch ? { agentId: patch.agentId, searchDepth: patch.searchDepth } : {};
      },
    }),
  });
  register<MetaParams>({
    layer: 'metaController',
    id: 'rating',
    schema: MetaParamsSchema,
    defaults: MetaParamsSchema.parse({}),
    create: params => ({
      id: 'rating',
      params,
      select(view: MetaView): MetaAdjustment {
        const rating = view.rating ?? 0;
        const band = params.ratingBands.find(item => rating >= item.min && rating < item.max);
        return band ? { agentId: band.agentId, searchDepth: band.searchDepth } : {};
      },
    }),
  });
}

function phaseOf(view: MetaView, params: MetaParams): 'opening' | 'mid' | 'endgame' {
  const mine = aliveCount(view.battle, view.side);
  const foe = aliveCount(view.battle, otherSide(view.side));
  if (mine <= params.endgameMons || foe <= params.endgameMons) return 'endgame';
  if ((view.battle.turn || 0) <= params.openingTurns) return 'opening';
  return 'mid';
}

function archetypeOf(view: MetaView): string {
  const foe = view.battle.getSide(otherSide(view.side)).active[0];
  if (boostSum(foe) >= 2) return 'setup';
  if (hazardScore(view.battle, view.side) > 0) return 'hazard';
  const spe = foe?.storedStats?.spe || 0;
  const offense = Math.max(foe?.storedStats?.atk || 0, foe?.storedStats?.spa || 0);
  if (spe >= 200 && offense >= 180) return 'offense';
  return 'balanced';
}
