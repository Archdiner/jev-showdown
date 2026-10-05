import * as fs from 'fs';
import * as path from 'path';
import { Dex } from '@pkmn/sim';
import { dataLoader } from '../data/data-loader.js';
import { RandbatsStats, RoleData, SpeciesStats } from '../types/index.js';

/** Randbats teams are six. The live sim used to omit every unseen teammate. */
export const FOE_TEAM_SIZE = 6;

const MAX_MOVES = 4;

/**
 * Search budgets below this stay on the revealed-only foe.
 * The ladder budget is seconds, so this only trips when concurrency has
 * already squeezed the decision. One weighted set is cheap; eight sampled
 * worlds would repeat the whole search.
 */
export const FOE_PRIOR_MIN_BUDGET_MS = 80;

export interface FoeSketch {
  species: string;
  level: number;
  hp: number;
  maxhp: number;
  status?: string;
  ability?: string;
  item?: string;
  teraType?: string;
  moves: string[];
  boosts?: Partial<Record<'atk' | 'def' | 'spa' | 'spd' | 'spe', number>>;
  fainted?: boolean;
  placeholder?: boolean;
}

export interface CompleteFoeOptions {
  teamSize?: number;
  /** Stable placeholder draw. Defaults to a hash of the revealed species. */
  seed?: number;
}

interface RoleMass {
  name: string;
  data: RoleData;
  p: number;
}

/**
 * The table the decision worker already loaded.
 * Gap 4 blends observed ladder counts into this same call.
 */
export function loadedSpeciesStats(): RandbatsStats | null {
  try {
    return dataLoader.tryGetStats();
  } catch {
    return null;
  }
}

/** A one-species test stub is not a randbats table. */
const MIN_PRIOR_SPECIES = 100;
let fileStats: RandbatsStats | null | undefined;

/** Loaded stats, or data/gen9-stats.json when that file is the full table. */
export function randbatsForPriors(): RandbatsStats | null {
  const loaded = loadedSpeciesStats();
  if (loaded && Object.keys(loaded).length >= MIN_PRIOR_SPECIES) return loaded;
  if (fileStats !== undefined) return fileStats;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'gen9-stats.json'), 'utf8')) as RandbatsStats;
    fileStats = parsed && Object.keys(parsed).length >= MIN_PRIOR_SPECIES ? parsed : null;
  } catch {
    fileStats = null;
  }
  return fileStats;
}

/**
 * Lock every revealed move, item, and ability. Fill the open move slots,
 * item, and ability from the role posterior. Append placeholder teammates
 * until the team is full so a knockout of the last revealed Pokémon is not
 * a terminal win.
 *
 * An empty `known` list is returned unchanged. Inventing a lead when nothing
 * has switched in would replace the real active with a guess.
 */
export function completeFoeTeam(
  known: FoeSketch[],
  stats: RandbatsStats,
  options?: CompleteFoeOptions,
): FoeSketch[] {
  if (known.length === 0) return [];
  const teamSize = options?.teamSize ?? FOE_TEAM_SIZE;
  const filled = known.slice(0, teamSize).map(mon => fillKnown(mon, stats));
  const need = teamSize - filled.length;
  if (need <= 0) return filled;
  const seen = new Set(filled.map(mon => speciesId(mon.species)));
  const seed = options?.seed ?? hashSeed(filled.map(mon => mon.species).join('|'));
  for (const species of pickSpecies(stats, seen, need, seed)) {
    const table = lookup(stats, species);
    filled.push(fillKnown({
      species,
      level: table?.level || 80,
      hp: 100,
      maxhp: 100,
      moves: [],
      fainted: false,
      placeholder: true,
    }, stats));
  }
  return filled;
}

export function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function fillKnown(mon: FoeSketch, stats: RandbatsStats): FoeSketch {
  const table = lookup(stats, mon.species);
  const revealedMoves = canonicalMoves(mon.moves);
  if (!table) {
    return { ...mon, moves: revealedMoves };
  }
  const roles = posterior(table, {
    moves: revealedMoves,
    ability: canonicalAbility(mon.ability),
    item: canonicalItem(mon.item),
    teraType: mon.teraType,
  });
  const moves = fillMoves(revealedMoves, roles);
  const ability = canonicalAbility(mon.ability) || mode(marginal(roles, 'abilities', role => abilityTable(role.data, table)));
  const item = canonicalItem(mon.item) || mode(marginal(roles, 'items', role => role.data.items || table.items || {}));
  return {
    ...mon,
    moves,
    ability: ability || mon.ability,
    item: item || mon.item,
  };
}

function posterior(
  table: SpeciesStats,
  revealed: { moves: string[]; ability?: string; item?: string; teraType?: string },
): RoleMass[] {
  let roles: RoleMass[] = Object.entries(table.roles || {})
    .filter(([, data]) => (data.weight || 0) > 0)
    .map(([name, data]) => ({ name, data, p: data.weight }));
  if (roles.length === 0) return [];

  const constraints: Array<{ keep: (role: RoleMass) => boolean; scale: (role: RoleMass) => number }> = [];
  for (const move of revealed.moves) {
    constraints.push({
      keep: role => weightOf(role.data.moves, move, 'moves') > 0,
      scale: role => weightOf(role.data.moves, move, 'moves'),
    });
  }
  if (revealed.ability) {
    const ability = revealed.ability;
    constraints.push({
      keep: role => weightOf(abilityTable(role.data, table), ability, 'abilities') > 0,
      scale: role => weightOf(abilityTable(role.data, table), ability, 'abilities'),
    });
  }
  if (revealed.item) {
    const item = revealed.item;
    constraints.push({
      keep: role => weightOf(role.data.items || table.items, item, 'items') > 0,
      scale: role => weightOf(role.data.items || table.items, item, 'items'),
    });
  }
  if (revealed.teraType) {
    const tera = revealed.teraType;
    constraints.push({
      keep: role => weightOf(role.data.teraTypes, tera, 'types') > 0,
      scale: role => weightOf(role.data.teraTypes, tera, 'types'),
    });
  }

  const applied: Array<(role: RoleMass) => number> = [];
  for (const constraint of constraints) {
    const survivors = roles.filter(constraint.keep);
    // A reveal the table has never seen must not wipe every role back to Tackle.
    if (survivors.length === 0) continue;
    roles = survivors;
    applied.push(constraint.scale);
  }
  for (const role of roles) {
    for (const scale of applied) role.p *= scale(role);
  }
  const total = roles.reduce((sum, role) => sum + role.p, 0);
  if (total <= 0) {
    const share = 1 / roles.length;
    for (const role of roles) role.p = share;
  } else {
    for (const role of roles) role.p /= total;
  }
  return roles;
}

function fillMoves(revealed: string[], roles: RoleMass[]): string[] {
  const moves = revealed.slice(0, MAX_MOVES);
  if (moves.length >= MAX_MOVES || roles.length === 0) return moves;
  const ranked = [...marginal(roles, 'moves', role => role.data.moves).entries()]
    .filter(([, weight]) => weight > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const seen = new Set(moves.map(move => dexId('moves', move)));
  for (const [name] of ranked) {
    if (moves.length >= MAX_MOVES) break;
    const id = dexId('moves', name);
    if (!id || seen.has(id)) continue;
    const canonical = canonicalMove(name);
    if (!canonical) continue;
    seen.add(id);
    moves.push(canonical);
  }
  return moves;
}

function marginal(
  roles: RoleMass[],
  kind: DexKind,
  tableOf: (role: RoleMass) => Record<string, number> | undefined,
): Map<string, number> {
  const weights = new Map<string, number>();
  for (const role of roles) {
    const table = tableOf(role);
    if (!table) continue;
    for (const [name, weight] of Object.entries(table)) {
      if (weight <= 0) continue;
      const key = displayName(name, kind) || name;
      weights.set(key, (weights.get(key) || 0) + role.p * weight);
    }
  }
  return weights;
}

function mode(weights: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestWeight = 0;
  for (const [name, weight] of weights) {
    if (weight > bestWeight || (weight === bestWeight && best !== undefined && name.localeCompare(best) < 0)) {
      best = name;
      bestWeight = weight;
    }
  }
  return bestWeight > 0 ? best : undefined;
}

function abilityTable(role: RoleData, species: SpeciesStats): Record<string, number> {
  if (role.abilities && Object.keys(role.abilities).length > 0) return role.abilities;
  return species.abilities || {};
}

function lookup(stats: RandbatsStats, species: string): SpeciesStats | undefined {
  if (stats[species]) return stats[species];
  const name = Dex.species.get(species).name;
  if (name && stats[name]) return stats[name];
  return undefined;
}

function pickSpecies(stats: RandbatsStats, seen: Set<string>, count: number, seed: number): string[] {
  const pool = Object.keys(stats).filter(name => {
    const id = speciesId(name);
    return id && !seen.has(id) && Dex.species.get(name).exists;
  }).sort();
  const rng = mulberry32(seed);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const swap = pool[i];
    pool[i] = pool[j];
    pool[j] = swap;
  }
  return pool.slice(0, count);
}

function canonicalMoves(moves: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of moves) {
    const name = canonicalMove(raw);
    if (!name) continue;
    const id = dexId('moves', name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(name);
  }
  return out;
}

function canonicalMove(raw: string): string | null {
  if (!raw || raw === 'Recharge' || raw === 'Struggle') return null;
  const move = Dex.moves.get(raw);
  return move.exists ? move.name : null;
}

function canonicalAbility(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const ability = Dex.abilities.get(raw);
  return ability.exists ? ability.name : undefined;
}

function canonicalItem(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const item = Dex.items.get(raw);
  return item.exists ? item.name : undefined;
}

type DexKind = 'moves' | 'abilities' | 'items' | 'types';

function weightOf(table: Record<string, number> | undefined, name: string, kind: DexKind): number {
  if (!table) return 0;
  if (table[name]) return table[name];
  const id = dexId(kind, name);
  if (!id) return 0;
  for (const [key, value] of Object.entries(table)) {
    if (dexId(kind, key) === id) return value;
  }
  return 0;
}

function displayName(raw: string, kind: DexKind): string | undefined {
  if (kind === 'types') return raw;
  if (kind === 'moves') return Dex.moves.get(raw).exists ? Dex.moves.get(raw).name : undefined;
  if (kind === 'abilities') return Dex.abilities.get(raw).exists ? Dex.abilities.get(raw).name : undefined;
  return Dex.items.get(raw).exists ? Dex.items.get(raw).name : undefined;
}

function dexId(kind: DexKind, raw: string): string {
  if (kind === 'types') return raw.toLowerCase();
  if (kind === 'moves') return Dex.moves.get(raw).id || '';
  if (kind === 'abilities') return Dex.abilities.get(raw).id || '';
  return Dex.items.get(raw).id || '';
}

function speciesId(name: string): string {
  const species = Dex.species.get(name);
  return species.exists ? species.id : '';
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
