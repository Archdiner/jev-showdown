import type { Action, GameState, RandbatsStats } from '../../types/index.js';

/** Shared brief schema. Each block carries its own version. */
export const CONTEXT_SCHEMA_VERSION = 1;

/**
 * Block ids the strategist can turn on and off.
 * `meta-guidance` and `switch-odds` read `state/meta/` (see meta.ts).
 */
export const CONTEXT_BLOCK_IDS = [
  'sides',
  'set-inference',
  'damage-matrix',
  'switch-ins',
  'speed-tiers',
  'field',
  'history',
  'switch-odds',
  'win-conditions',
  'meta-guidance',
] as const;

export type ContextBlockId = (typeof CONTEXT_BLOCK_IDS)[number];

export interface BlockSettings {
  id: string;
  version: string;
  enabled: boolean;
  variant?: string;
  maxChars: number;
}

export interface ContextBlock {
  id: ContextBlockId;
  version: string;
  defaultMaxChars: number;
  render(input: BoardInput, settings: BlockSettings): string;
}

export interface BlockOverride {
  enabled?: boolean;
  maxChars?: number;
  variant?: string;
}

export interface ContextConfig {
  version: number;
  blocks?: Partial<Record<ContextBlockId, BlockOverride>>;
}

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  version: CONTEXT_SCHEMA_VERSION,
};

export interface StatSpread {
  hp: number;
  atk: number;
  def: number;
  spa: number;
  spd: number;
  spe: number;
}

export interface BoardMon {
  species: string;
  /** 1-based party slot. Switch choices use this number. */
  slot: number;
  active: boolean;
  fainted: boolean;
  /** False when this mon has not been on the field yet. Our bench can be unseen. */
  seen: boolean;
  level: number;
  hpPercent: number | null;
  status?: string;
  boosts: Partial<Record<'atk' | 'def' | 'spa' | 'spd' | 'spe', number>>;
  types: string[];
  /** Moves that have actually been used or that we know because they are ours. */
  knownMoves: string[];
  /** Slot order for our moves. Empty for the opponent. Index 0 is move 1. */
  moveSlots: string[];
  ability?: string;
  abilityKnown: boolean;
  item?: string;
  itemKnown: boolean;
  teraType?: string;
  teraKnown: boolean;
  terastallized?: string;
  nature?: string;
  evs?: StatSpread;
}

export interface LegalOption {
  id: string;
  choice: string;
  action: Action;
  label: string;
}

export interface LogSummary {
  recent: string[];
  opponentHardSwitches: number;
  opponentStays: number;
  opponentForcedSwitches: number;
  lastOpponentSwitchTurn: number | null;
}

export interface BoardInput {
  turn: number;
  player: 'p1' | 'p2' | 'unknown';
  foeSide: 'p1' | 'p2';
  myTeam: BoardMon[];
  opponentTeam: BoardMon[];
  myActive: number;
  opponentActive: number;
  field: GameState['field'];
  hazards: GameState['hazards'];
  myTeraUsed: boolean;
  opponentTeraUsed: boolean;
  canTera: boolean;
  log: LogSummary;
  legal: LegalOption[];
  pools: RandbatsStats;
  facts?: FactCache;
}

export interface RollLine {
  move: string;
  attacker: string;
  defender: string;
  text: string;
  maxPct: number;
}

export interface SetFact {
  species: string;
  side: 'mine' | 'opponent';
  text: string;
}

export interface FactCache {
  ourAttacks: RollLine[];
  foeAttacks: RollLine[];
  teraAttacks: RollLine[];
  speed: string;
  sets: SetFact[];
  threatened: boolean;
}

export interface RenderedBlock {
  id: string;
  version: string;
  chars: number;
  text: string;
}

export interface Brief {
  version: number;
  text: string;
  blocks: RenderedBlock[];
}
