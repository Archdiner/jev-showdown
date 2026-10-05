import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PRNG, type Battle } from '@pkmn/sim';
import {
  legalChoices,
  safeChoose,
  startRandomBattle,
  teamsForSeed,
  type SideId,
} from '../engine/exact/battle-utils.js';
import { exactSearch } from '../engine/exact/search.js';
import { battleFromInputLog } from './adapters.js';
import type { PositionRecord, PositionSplit } from './interfaces.js';

/** Deterministic 20% holdout. The same id always lands in the same split. */
export const HELD_OUT_PERCENT = 20;

export function splitFor(id: string): PositionSplit {
  const bucket = parseInt(createHash('sha256').update(id).digest('hex').slice(0, 8), 16) % 100;
  return bucket < HELD_OUT_PERCENT ? 'held-out' : 'dev';
}

export function devPositions(pool: PositionRecord[]): PositionRecord[] {
  return pool.filter(position => position.split === 'dev');
}

export function heldOutPositions(pool: PositionRecord[]): PositionRecord[] {
  return pool.filter(position => position.split === 'held-out');
}

export interface GenerateOptions {
  games?: number;
  seedStart?: number;
  maxPositions?: number;
  /** Teacher depth. Must be deeper than the champion's 1-ply search. */
  labelDepth?: number;
  outPath?: string;
}

const DEFAULT_POOL = path.join(process.cwd(), 'state', 'positions', 'pool.json');

export function poolPath(override?: string): string {
  return override || DEFAULT_POOL;
}

export function loadPool(file = DEFAULT_POOL): PositionRecord[] {
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as PositionRecord[];
  return parsed.map(position => ({ ...position, split: splitFor(position.id) }));
}

export function savePool(pool: PositionRecord[], file = DEFAULT_POOL): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const normalized = pool.map(position => ({ ...position, split: splitFor(position.id) }));
  fs.writeFileSync(file, JSON.stringify(normalized, null, 2));
}

/**
 * Seeded random games. Each decision with more than one legal choice is
 * labeled by a deeper exact search. The split is a hash, not a hand pick.
 */
export function generatePositions(options: GenerateOptions = {}): PositionRecord[] {
  const games = options.games ?? 4;
  const seedStart = options.seedStart ?? 1;
  const maxPositions = options.maxPositions ?? 24;
  const labelDepth = options.labelDepth ?? 2;
  if (labelDepth < 2) throw new Error('Position labels must come from a deeper exact search than 1-ply');
  const records: PositionRecord[] = [];
  for (let game = 0; game < games && records.length < maxPositions; game++) {
    const seed = seedStart + game;
    const teams = teamsForSeed(seed);
    const battle = startRandomBattle(teams.p1, teams.p2, seed);
    const rng = new PRNG([seed >>> 0, 9, 9, 9] as never);
    let guard = 0;
    while (!battle.ended && battle.turn <= 6 && records.length < maxPositions && guard < 40) {
      guard++;
      const p1 = legalChoices(battle, 'p1');
      const p2 = legalChoices(battle, 'p2');
      if (p1.length > 1) {
        records.push(labelPosition(battle, 'p1', seed, labelDepth, 'generated'));
      }
      const c1 = p1.length ? p1[rng.random(p1.length)] : undefined;
      const c2 = p2.length ? p2[rng.random(p2.length)] : undefined;
      if (c1) safeChoose(battle, 'p1', c1);
      if (!battle.ended && c2) safeChoose(battle, 'p2', c2);
      if (!c1 && !c2) break;
    }
  }
  if (options.outPath) savePool(mergePool(loadPool(options.outPath), records), options.outPath);
  return records.map(position => ({ ...position, split: splitFor(position.id) }));
}

/**
 * Losses become positions, never species rules. Callers cannot choose the split.
 */
export function minePosition(args: {
  battle: Battle;
  side: SideId;
  seed: number;
  labelDepth?: number;
  outPath?: string;
}): PositionRecord {
  const labelDepth = args.labelDepth ?? 2;
  const record = labelPosition(args.battle, args.side, args.seed, labelDepth, 'mined');
  const file = poolPath(args.outPath);
  savePool(mergePool(loadPool(file), [record]), file);
  return record;
}

export async function agreement(
  positions: PositionRecord[],
  decide: (battle: Battle, side: SideId) => Promise<{ choice: string }>
): Promise<number> {
  if (positions.length === 0) return 0;
  let hits = 0;
  for (const position of positions) {
    const battle = battleFromInputLog(position.inputLog);
    const legal = legalChoices(battle, position.side);
    const decision = await decide(battle, position.side);
    if (decision.choice === position.label || (legal.length === 1 && legal[0] === decision.choice)) hits++;
  }
  return hits / positions.length;
}

function labelPosition(
  battle: Battle,
  side: SideId,
  seed: number,
  labelDepth: number,
  source: PositionRecord['source']
): PositionRecord {
  const inputLog = battle.inputLog.join('\n');
  const id = createHash('sha256').update(`${source}|${seed}|${battle.turn}|${side}|${inputLog}`).digest('hex').slice(0, 16);
  const labeled = exactSearch(battle, side, {
    depth: labelDepth,
    opponentModel: 'max-damage',
    evalMode: 'hp',
    errorAsLoss: false,
  });
  return {
    id,
    source,
    split: splitFor(id),
    seed,
    turn: battle.turn,
    side,
    inputLog,
    label: labeled.choice,
    labelDepth,
  };
}

function mergePool(existing: PositionRecord[], extra: PositionRecord[]): PositionRecord[] {
  const byId = new Map<string, PositionRecord>();
  for (const position of [...existing, ...extra]) byId.set(position.id, { ...position, split: splitFor(position.id) });
  return [...byId.values()];
}
