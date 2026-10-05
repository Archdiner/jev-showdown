import type { Battle } from '@pkmn/sim';
import type { SideId } from '../../engine/exact/battle-utils.js';
import { battleToState } from '../../engine/exact/search.js';
import { buildBattleFacts, type BattleFacts } from '../../llm/battle-facts.js';
import { dataLoader } from '../../data/data-loader.js';
import { register } from '../registry.js';
import { ContextParamsSchema, defaultBlocks, type ContextParams } from '../schema.js';
import type { GamePlan } from '../interfaces.js';
import type { SetInferenceImpl } from './opponent.js';

export const EXPERT_TIPS = [
  'Preserve a speed-control option into the endgame.',
  'Do not spend a preserved mon to chip something that is not the win condition.',
  'Hazards punish switches. Avoid switching a preserved mon into them.',
  'Tera is one-shot. Spend it to secure the win condition or to avoid a loss.',
  'A boost on the opponent is a reason to revenge or switch, not to trade blindly.',
  'In the endgame, direct damage outranks setup.',
];

export interface ContextInput {
  battle: Battle;
  side: SideId;
  plan: GamePlan | null;
  scores: Array<{ choice: string; score: number }>;
  behaviorId: string;
  rating?: number;
  setInference: SetInferenceImpl;
  memory: Map<string, string>;
}

export interface ContextRender {
  text: string;
  facts?: BattleFacts;
  included: string[];
  truncated: string[];
}

export interface ContextImpl {
  id: string;
  params: ContextParams;
  memory: Map<string, string>;
  render(input: ContextInput): ContextRender;
  remember(battle: Battle, side: SideId, choice: string): void;
}

export function registerContext(): void {
  register<ContextParams>({
    layer: 'context',
    id: 'blocks',
    schema: ContextParamsSchema,
    defaults: { globalTokenBudget: 4000, blocks: defaultBlocks() },
    create: params => {
      const memory = new Map<string, string>();
      return {
        id: 'blocks',
        params,
        memory,
        remember(battle: Battle, side: SideId, choice: string) {
          memory.set(memoryKey(battle, side), choice);
        },
        render(input: ContextInput): ContextRender {
          return renderBlocks(params, { ...input, memory });
        },
      };
    },
  });
}

function renderBlocks(params: ContextParams, input: ContextInput): ContextRender {
  const state = battleToState(input.battle, input.side);
  let facts: BattleFacts | undefined;
  const pieces = params.blocks.filter(block => block.enabled).map(block => {
    if (block.id === 'calc-sheet') {
      try {
        facts = buildBattleFacts(state, [], pools());
      } catch {
        facts = { text: 'calc sheet unavailable', criteria: {} };
      }
    }
    const text = formatBlock(block.format, blockText(block.id, input, facts));
    return { ...block, text };
  });
  pieces.sort((a, b) => b.priority - a.priority);
  let used = 0;
  const kept: Array<{ id: string; text: string }> = [];
  const truncated: string[] = [];
  for (const block of pieces) {
    const room = Math.min(block.tokenBudget, params.globalTokenBudget - used);
    if (room <= 0) {
      truncated.push(block.id);
      continue;
    }
    const chars = room * 4;
    const text = block.text.length > chars ? block.text.slice(0, chars) : block.text;
    if (text.length < block.text.length) truncated.push(block.id);
    kept.push({ id: block.id, text });
    used += Math.ceil(text.length / 4);
  }
  const prefix = kept.filter(block => block.id !== 'calc-sheet').map(block => `## ${block.id}\n${block.text}`);
  return {
    text: prefix.join('\n'),
    facts,
    included: kept.map(block => block.id),
    truncated,
  };
}

function blockText(id: string, input: ContextInput, facts?: BattleFacts): string {
  const me = input.battle.getSide(input.side);
  const foe = me.foe;
  if (id === 'calc-sheet') return facts?.text || '';
  if (id === 'board') {
    return [
      `turn ${input.battle.turn} side ${input.side}`,
      `active ${me.active[0]?.species?.name || 'none'} vs ${foe.active[0]?.species?.name || 'none'}`,
      `alive ${me.pokemon.filter(mon => !mon.fainted).length}-${foe.pokemon.filter(mon => !mon.fainted).length}`,
    ].join('\n');
  }
  if (id === 'search-top-k') {
    return input.scores.slice(0, 8).map(row => `${row.choice} ${row.score.toFixed(2)}`).join('\n') || 'none';
  }
  if (id === 'game-plan') {
    if (!input.plan) return 'none';
    return `${input.plan.style}. win ${input.plan.winCondition}. preserve ${input.plan.preserve.join(', ') || 'none'}. ${input.plan.notes}`;
  }
  if (id === 'field') {
    const field = input.battle.field as { weather?: string; terrain?: string; trickRoom?: boolean };
    return `weather ${field.weather || 'none'} terrain ${field.terrain || 'none'} trickRoom ${Boolean(field.trickRoom)}`;
  }
  if (id === 'opponent-sets') {
    const active = foe.active[0];
    if (!active) return '[]';
    const belief = {
      species: active.species?.name || 'Unknown',
      level: active.level,
      possibleSets: new Map<string, number>(),
      revealedMoves: new Set((active.moveSlots || []).filter(slot => slot.used).map(slot => slot.id)),
      revealedAbility: active.ability,
      revealedItem: active.item,
    };
    return JSON.stringify(input.setInference.narrow(belief));
  }
  if (id === 'revealed-history') {
    const lines = foe.pokemon.map(mon => {
      const moves = (mon.moveSlots || []).filter(slot => slot.used).map(slot => slot.id);
      return `${mon.species?.name}: ${moves.join(', ') || 'none'}`;
    });
    return lines.join('\n');
  }
  if (id === 'opponent-tendencies') {
    return `behavior ${input.behaviorId} rating ${input.rating ?? 'unknown'}`;
  }
  if (id === 'expert-tips') return EXPERT_TIPS.join('\n');
  const previous = input.memory.get(memoryKey(input.battle, input.side));
  return previous ? `similar matchup previously chose ${previous}` : 'none';
}

function formatBlock(format: 'prose' | 'table' | 'json', text: string): string {
  if (format === 'json') {
    try {
      return JSON.stringify(JSON.parse(text));
    } catch {
      return JSON.stringify({ text });
    }
  }
  if (format === 'table') return text;
  return text;
}

function memoryKey(battle: Battle, side: SideId): string {
  const me = battle.getSide(side).active[0]?.species?.name || 'none';
  const foe = battle.getSide(side).foe.active[0]?.species?.name || 'none';
  return `${me}|${foe}`;
}

function pools() {
  try {
    return dataLoader.getStats();
  } catch {
    return {};
  }
}
