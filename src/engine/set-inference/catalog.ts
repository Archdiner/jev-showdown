import { Dex } from '@pkmn/sim';
import type { RandbatsStats, RoleData, SpeciesStats } from '../../types/index.js';

export interface StatBlock {
  hp: number;
  atk: number;
  def: number;
  spa: number;
  spd: number;
  spe: number;
}

export interface MoveSetDist {
  sets: string[][];
  probs: number[];
}

const cache = new Map<string, MoveSetDist | null>();

export function toId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function moveName(raw: string | undefined): string | null {
  if (!raw || raw === 'Recharge' || raw === 'Struggle') return null;
  const move = Dex.moves.get(raw);
  return move.exists ? move.name : null;
}

export function abilityName(raw: string | undefined): string | null {
  if (!raw) return null;
  const ability = Dex.abilities.get(raw);
  return ability.exists ? ability.name : null;
}

export function itemName(raw: string | undefined): string | null {
  if (!raw) return null;
  const item = Dex.items.get(raw);
  return item.exists ? item.name : null;
}

export function typeName(raw: string | undefined): string | null {
  if (!raw) return null;
  const type = Dex.types.get(raw);
  return type.exists ? type.name : null;
}

export function lookupSpecies(
  stats: RandbatsStats,
  species: string,
): { key: string; table: SpeciesStats } | null {
  if (stats[species]) return { key: species, table: stats[species] };
  const dex = Dex.species.get(species);
  if (dex.exists && stats[dex.name]) return { key: dex.name, table: stats[dex.name] };
  const id = dex.exists ? dex.id : toId(species);
  for (const key of Object.keys(stats)) {
    const entry = Dex.species.get(key);
    if ((entry.exists ? entry.id : toId(key)) === id) return { key, table: stats[key] };
  }
  return null;
}

export function tableWeight(table: Record<string, number> | undefined, name: string, kind: 'moves' | 'abilities' | 'items' | 'types'): number {
  if (!table) return 0;
  if (table[name]) return table[name];
  const id = kind === 'types' ? name.toLowerCase() : kind === 'moves' ? Dex.moves.get(name).id : kind === 'abilities' ? Dex.abilities.get(name).id : Dex.items.get(name).id;
  if (!id && kind !== 'types') return 0;
  for (const [key, value] of Object.entries(table)) {
    const keyId = kind === 'types' ? key.toLowerCase() : kind === 'moves' ? Dex.moves.get(key).id : kind === 'abilities' ? Dex.abilities.get(key).id : Dex.items.get(key).id;
    if (keyId === id) return value;
  }
  return 0;
}

export function canonicalTable(
  table: Record<string, number> | undefined,
  kind: 'moves' | 'abilities' | 'items' | 'types',
): Array<{ name: string; weight: number }> {
  if (!table) return [];
  const merged = new Map<string, number>();
  for (const [raw, weight] of Object.entries(table)) {
    if (weight <= 0) continue;
    const name = kind === 'moves' ? moveName(raw) : kind === 'abilities' ? abilityName(raw) : kind === 'items' ? itemName(raw) : typeName(raw);
    if (!name) continue;
    merged.set(name, (merged.get(name) || 0) + weight);
  }
  return [...merged.entries()].map(([name, weight]) => ({ name, weight }));
}

export function abilityTable(role: RoleData, species: SpeciesStats): Record<string, number> {
  if (role.abilities && Object.keys(role.abilities).length > 0) return role.abilities;
  return species.abilities || {};
}

export function itemTable(role: RoleData, species: SpeciesStats): Record<string, number> {
  if (role.items && Object.keys(role.items).length > 0) return role.items;
  return species.items || {};
}

/** Randbats non-HP stat: 31 IVs and neutral nature unless the role says otherwise. */
export function randbatsStat(base: number, level: number, ev = 85, iv = 31): number {
  return Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100 + 5);
}

export function randbatsHp(base: number, level: number, ev = 85, iv = 31): number {
  return Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + level + 10;
}

export function spreadFor(species: string, level: number, role?: RoleData, speciesTable?: SpeciesStats): { evs: StatBlock; ivs: StatBlock; stats: StatBlock } {
  const evs: StatBlock = { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 };
  const ivs: StatBlock = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
  for (const source of [speciesTable?.evs, role?.evs]) {
    if (!source) continue;
    for (const key of Object.keys(evs) as Array<keyof StatBlock>) {
      if (typeof source[key] === 'number') evs[key] = source[key] as number;
    }
  }
  for (const source of [speciesTable?.ivs, role?.ivs]) {
    if (!source) continue;
    for (const key of Object.keys(ivs) as Array<keyof StatBlock>) {
      if (typeof source[key] === 'number') ivs[key] = source[key] as number;
    }
  }
  const base = Dex.species.get(species).baseStats;
  return {
    evs,
    ivs,
    stats: {
      hp: base ? randbatsHp(base.hp, level, evs.hp, ivs.hp) : 0,
      atk: base ? randbatsStat(base.atk, level, evs.atk, ivs.atk) : 0,
      def: base ? randbatsStat(base.def, level, evs.def, ivs.def) : 0,
      spa: base ? randbatsStat(base.spa, level, evs.spa, ivs.spa) : 0,
      spd: base ? randbatsStat(base.spd, level, evs.spd, ivs.spd) : 0,
      spe: base ? randbatsStat(base.spe, level, evs.spe, ivs.spe) : 0,
    },
  };
}

export function stageMultiplier(stage: number): number {
  const clamped = Math.max(-6, Math.min(6, stage));
  return clamped >= 0 ? (2 + clamped) / 2 : 2 / (2 - clamped);
}

/**
 * Distribution over exactly-4 move sets.
 * Locked moves (frequency 1) are always in. The weight of a set is the
 * Bernoulli likelihood of its inclusions, conditioned on size 4 and on
 * `mustInclude`. Returns null when `mustInclude` is impossible for this pool.
 */
export function moveSetDistribution(freqs: Record<string, number>, mustInclude: string[]): MoveSetDist | null {
  const canonMust = mustInclude.map(move => moveName(move) || move);
  const key = `${JSON.stringify(freqs)}|${[...canonMust].sort().join(',')}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const built = buildMoveSets(freqs, canonMust);
  cache.set(key, built);
  return built;
}

function buildMoveSets(freqs: Record<string, number>, mustInclude: string[]): MoveSetDist | null {
  const pool = canonicalTable(freqs, 'moves');
  if (pool.length === 0) return null;
  const byName = new Map(pool.map(row => [row.name, row.weight]));
  for (const move of mustInclude) {
    if (!byName.has(move)) return null;
  }
  const locked = pool.filter(row => row.weight >= 0.999).map(row => row.name);
  const must = new Set<string>([...locked, ...mustInclude]);
  if (must.size > 4) {
    const ranked = [...must].sort((a, b) => (byName.get(b) || 0) - (byName.get(a) || 0) || a.localeCompare(b));
    const kept = new Set<string>(mustInclude);
    for (const name of ranked) {
      if (kept.size >= 4) break;
      kept.add(name);
    }
    must.clear();
    for (const name of kept) must.add(name);
  }
  const variable = pool.map(row => row.name).filter(name => !must.has(name));
  const slots = Math.max(0, Math.min(4, pool.length) - must.size);
  if (slots > variable.length) return null;
  if (choose(variable.length, slots) > 2500) {
    return independentFallback(pool, [...must]);
  }
  const extras = combinations(variable, slots);
  const universe = pool.map(row => row.name);
  const weights = extras.map(extra => bernoulliWeight(universe, byName, [...must, ...extra]));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return null;
  return {
    sets: extras.map(extra => [...must, ...extra].sort()),
    probs: weights.map(weight => weight / total),
  };
}

function independentFallback(pool: Array<{ name: string; weight: number }>, must: string[]): MoveSetDist {
  const names = new Set(must);
  const ranked = pool.filter(row => !names.has(row.name)).sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  for (const row of ranked) {
    if (names.size >= 4) break;
    names.add(row.name);
  }
  return { sets: [[...names].sort()], probs: [1] };
}

function bernoulliWeight(universe: string[], freqs: Map<string, number>, set: string[]): number {
  const chosen = new Set(set);
  let weight = 1;
  for (const name of universe) {
    const p = Math.min(0.999, Math.max(0.001, freqs.get(name) || 0));
    weight *= chosen.has(name) ? p : 1 - p;
  }
  return weight;
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1);
  return result;
}

function combinations(items: string[], k: number): string[][] {
  if (k === 0) return [[]];
  if (k > items.length) return [];
  const out: string[][] = [];
  const chosen: string[] = [];
  const walk = (start: number) => {
    if (chosen.length === k) {
      out.push(chosen.slice());
      return;
    }
    for (let i = start; i <= items.length - (k - chosen.length); i++) {
      chosen.push(items[i]);
      walk(i + 1);
      chosen.pop();
    }
  };
  walk(0);
  return out;
}

export function containsAll(set: string[], moves: string[]): boolean {
  return moves.every(move => set.includes(move));
}

/** Positive effectiveness means the species is weak; above 1 means 4x. */
export function effectiveness(attackType: string, speciesName: string): number {
  const species = Dex.species.get(speciesName);
  if (!species.exists) return 0;
  return Dex.getEffectiveness(attackType, species);
}

export function baseSpeciesName(speciesName: string): string {
  const species = Dex.species.get(speciesName);
  return species.exists ? species.baseSpecies : speciesName;
}

export function speciesTypes(speciesName: string): string[] {
  const species = Dex.species.get(speciesName);
  return species.exists ? [...species.types] : [];
}

export function dexAbilities(speciesName: string): string[] {
  const species = Dex.species.get(speciesName);
  if (!species.exists) return [];
  return Object.values(species.abilities).filter((ability): ability is string => Boolean(ability));
}

export function levelOf(table: SpeciesStats | undefined, fallback: number): number {
  return table?.level || fallback || 80;
}

export function isStatus(move: string): boolean {
  const entry = Dex.moves.get(move);
  return entry.exists && entry.category === 'Status';
}

export function movePriority(move: string): number {
  const entry = Dex.moves.get(move);
  return entry.exists ? entry.priority : 0;
}

/** Status moves a Choice item is allowed to carry. Every other status move rules Choice out. */
const CHOICE_STATUS = new Set(['trick', 'switcheroo', 'healingwish', 'revivalblessing']);

export function statusBansChoice(move: string): boolean {
  const entry = Dex.moves.get(move);
  if (!entry.exists || entry.category !== 'Status') return false;
  return !CHOICE_STATUS.has(entry.id);
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickWeighted<T>(items: T[], weightOf: (item: T) => number, rng: () => number): T {
  const total = items.reduce((sum, item) => sum + Math.max(0, weightOf(item)), 0);
  if (total <= 0) return items[items.length - 1];
  let roll = rng() * total;
  for (const item of items) {
    roll -= Math.max(0, weightOf(item));
    if (roll <= 0) return item;
  }
  return items[items.length - 1];
}
