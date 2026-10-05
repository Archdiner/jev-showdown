import { Dex, PRNG, PokemonSet } from '@pkmn/sim';
import type { RandbatsStats, RoleData, SpeciesStats } from '../../types/index.js';
import type { FoeMon } from '../../client/decision-battle.js';
import { inferenceFromFoes, sampleWorlds as drawCalibratedWorlds } from '../set-inference/index.js';
import { toPokemonSet } from '../set-inference/sample.js';

/** Eval and search refuse a stub. Real gen9 randbats is about 509 species. */
export const MIN_RANDBATS_SPECIES = 500;

export const TEAM_SIZE = 6;

export type OpponentStyle = 'aggressive' | 'stall' | 'balanced';

/** `loose` draws from raw randbats weights. `calibrated` draws from the set-inference posterior. */
export type WorldSampler = 'loose' | 'calibrated';

export interface WorldSample {
  foeTeam: PokemonSet[];
  weight: number;
  tag: string;
}

export interface WorldEvidence {
  knownFoes: FoeMon[];
  teamSize?: number;
  myHazards?: string[];
  foeHazards?: string[];
}

const OFFENSE_ITEMS = new Set([
  'assaultvest', 'lifeorb', 'expertbelt', 'choicescarf', 'choiceband', 'choicespecs',
]);
const STALL_ITEMS = new Set([
  'leftovers', 'blacksludge', 'rockyhelmet', 'heavydutyboots', 'sitrusberry',
]);

export function assertRandbatsSpecies(stats: RandbatsStats, min = MIN_RANDBATS_SPECIES): void {
  const count = Object.keys(stats).length;
  if (count < min) {
    throw new Error(
      `Randbats data has ${count} species (need at least ${min}). Run npm run data:refresh.`,
    );
  }
}

/**
 * Sample K opponent teams. Revealed moves, ability, and item are fixed.
 * A status move rules out Assault Vest. Hazard chip rules out Heavy-Duty Boots.
 * Unrevealed teammates are drawn from the randbats table.
 */
export function sampleWorlds(
  evidence: WorldEvidence,
  k: number,
  stats: RandbatsStats,
  rng: PRNG,
  style: OpponentStyle = 'balanced',
): WorldSample[] {
  assertRandbatsSpecies(stats);
  const teamSize = evidence.teamSize ?? TEAM_SIZE;
  const worlds: WorldSample[] = [];
  for (let i = 0; i < k; i++) {
    const world = sampleWorld(evidence, teamSize, stats, rng, style);
    if (world) worlds.push(world);
  }
  return dedupe(worlds);
}

/**
 * Hybrid's world draw. `loose` is the raw randbats sampler. `calibrated` is
 * `SetInference.sampleWorlds`, conditioned on revealed sets, hazard chip, and speed.
 */
export function sampleHybridWorlds(
  evidence: WorldEvidence,
  k: number,
  stats: RandbatsStats,
  rng: PRNG,
  style: OpponentStyle = 'balanced',
  sampler: WorldSampler = 'loose',
  speed?: { ourSpeed: number },
): WorldSample[] {
  if (sampler === 'calibrated') return sampleCalibrated(evidence, k, stats, rng, speed);
  return sampleWorlds(evidence, k, stats, rng, style);
}

function sampleCalibrated(
  evidence: WorldEvidence,
  k: number,
  stats: RandbatsStats,
  rng: PRNG,
  speed?: { ourSpeed: number },
): WorldSample[] {
  assertRandbatsSpecies(stats);
  const inference = inferenceFromFoes(stats, evidence.knownFoes.map(sketchOf), {
    seed: 1 + rng.random(0x7ffffffe),
    ourSide: 'p1',
  });
  for (const mon of evidence.knownFoes) {
    if (mon.hazardChip) inference.noteHazard(mon.species, 'Stealth Rock');
    if (speed && speed.ourSpeed > 0 && mon.speed) {
      inference.noteSpeed({
        species: mon.species,
        foeMovedFirst: mon.speed === 'faster',
        ourSpeed: speed.ourSpeed,
        foeStage: mon.boosts?.spe || 0,
        foeParalyzed: mon.status === 'par',
      });
    }
  }
  return drawCalibratedWorlds(inference, k).flatMap(world => {
    const foeTeam = world.team.map(mon => toPokemonSet(mon)).filter(set => Dex.species.get(set.species).exists);
    if (foeTeam.length === 0) return [];
    return [{ foeTeam, weight: world.weight, tag: world.tag }];
  });
}

function sketchOf(mon: FoeMon): { species: string; level: number; moves: string[]; ability?: string; item?: string; teraType?: string } {
  return {
    species: mon.species,
    level: mon.level || 80,
    moves: (mon.moves || []).filter(move => !isFillerMove(toId(move))),
    ability: mon.ability,
    item: mon.item,
    teraType: mon.terastallized,
  };
}

function sampleWorld(
  evidence: WorldEvidence,
  teamSize: number,
  stats: RandbatsStats,
  rng: PRNG,
  style: OpponentStyle,
): WorldSample | null {
  const foeTeam: PokemonSet[] = [];
  const tags: string[] = [];
  let logProb = 0;
  const used = new Set<string>();

  for (const mon of evidence.knownFoes) {
    const sampled = sampleRevealed(mon, stats, rng, style);
    if (!sampled) return null;
    foeTeam.push(sampled.set);
    used.add(toId(sampled.set.species));
    tags.push(sampled.tag);
    logProb += sampled.logProb;
  }

  const need = Math.max(0, teamSize - foeTeam.length);
  for (let i = 0; i < need; i++) {
    const sampled = sampleUnrevealed(used, stats, rng, style);
    if (!sampled) break;
    foeTeam.push(sampled.set);
    used.add(toId(sampled.set.species));
    tags.push(`?${sampled.set.species}`);
    logProb += sampled.logProb;
  }
  if (foeTeam.length === 0) return null;
  return { foeTeam, weight: Math.exp(logProb), tag: tags.join(';') };
}

interface Sampled {
  set: PokemonSet;
  tag: string;
  logProb: number;
}

function sampleRevealed(mon: FoeMon, stats: RandbatsStats, rng: PRNG, style: OpponentStyle): Sampled | null {
  const speciesStats = lookupSpecies(stats, mon.species);
  const revealedMoves = (mon.moves || []).map(toId).filter(id => id && !isFillerMove(id));
  if (!speciesStats) {
    const set = createSet(mon.species, mon.level, revealedMoves.length ? revealedMoves : mon.moves, mon.ability, mon.item);
    if (!set) return null;
    return { set, tag: mon.species, logProb: 0 };
  }
  const roles = compatibleRoles(speciesStats, revealedMoves, mon);
  const pool = roles.length ? roles : allRoles(speciesStats);
  if (pool.length === 0) {
    const set = createSet(mon.species, speciesStats.level || mon.level, revealedMoves, mon.ability, mon.item);
    if (!set) return null;
    return { set, tag: mon.species, logProb: 0 };
  }
  const biased = pool.map(role => ({ ...role, weight: role.weight * roleBias(role.data, style) }));
  const picked = weighted(biased, rng);
  const set = setFromRole(
    mon.species,
    speciesStats.level || mon.level,
    picked.data,
    speciesStats,
    revealedMoves,
    mon.ability ? toId(mon.ability) : undefined,
    mon.item ? toId(mon.item) : undefined,
    mon,
    style,
    rng,
  );
  if (!set) return null;
  const total = biased.reduce((sum, role) => sum + role.weight, 0) || 1;
  return { set, tag: `${mon.species}:${picked.role}`, logProb: Math.log(picked.weight / total) };
}

function sampleUnrevealed(
  used: Set<string>,
  stats: RandbatsStats,
  rng: PRNG,
  style: OpponentStyle,
): Sampled | null {
  const available = Object.entries(stats).filter(([species]) => !used.has(toId(species)));
  if (available.length === 0) return null;
  const weights = available.map(([, row]) => speciesWeight(row));
  const index = weightedIndex(weights, rng);
  const [species, speciesStats] = available[index];
  const roles = allRoles(speciesStats).map(role => ({ ...role, weight: role.weight * roleBias(role.data, style) }));
  if (roles.length === 0) return null;
  const picked = weighted(roles, rng);
  const set = setFromRole(species, speciesStats.level, picked.data, speciesStats, [], undefined, undefined, undefined, style, rng);
  if (!set) return null;
  const roleTotal = roles.reduce((sum, role) => sum + role.weight, 0) || 1;
  const speciesTotal = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  return {
    set,
    tag: species,
    logProb: Math.log(weights[index] / speciesTotal) + Math.log(picked.weight / roleTotal),
  };
}

interface RolePick {
  role: string;
  data: RoleData;
  weight: number;
}

function allRoles(species: SpeciesStats): RolePick[] {
  return Object.entries(species.roles || {}).map(([role, data]) => ({
    role,
    data,
    weight: Number(data.weight) > 0 ? Number(data.weight) : 1,
  }));
}

function compatibleRoles(species: SpeciesStats, revealedMoves: string[], mon: FoeMon): RolePick[] {
  const roles: RolePick[] = [];
  for (const role of allRoles(species)) {
    const moves = asWeights(role.data.moves);
    const ok = revealedMoves.every(move => (moves[move] ?? 0) > 0 || (moves[toId(move)] ?? 0) > 0);
    if (!ok) continue;
    if (mon.item && !itemAllowed(toId(mon.item), mon)) continue;
    roles.push(role);
  }
  return roles;
}

function setFromRole(
  species: string,
  level: number,
  role: RoleData,
  speciesStats: SpeciesStats,
  requiredMoves: string[],
  requiredAbility: string | undefined,
  requiredItem: string | undefined,
  mon: FoeMon | undefined,
  style: OpponentStyle,
  rng: PRNG,
): PokemonSet | null {
  const movePool = Object.entries(asWeights(role.moves))
    .filter(([, weight]) => weight > 0)
    .map(([move, weight]) => ({ move: toId(move), weight }));
  const moves: string[] = [];
  const used = new Set<string>();
  for (const move of requiredMoves) {
    const id = toId(move);
    if (!id || used.has(id)) continue;
    moves.push(id);
    used.add(id);
  }
  while (moves.length < 4 && movePool.length > 0) {
    const available = movePool.filter(row => !used.has(row.move));
    if (available.length === 0) break;
    const picked = weighted(available, rng);
    moves.push(picked.move);
    used.add(picked.move);
  }

  const abilityPool = Object.entries(asWeights(speciesStats.abilities))
    .filter(([, weight]) => weight > 0)
    .map(([ability, weight]) => ({ ability: toId(ability), weight }));
  let ability = requiredAbility;
  if (!ability && abilityPool.length > 0) ability = weighted(abilityPool, rng).ability;

  const itemPool = Object.entries(asWeights(role.items || speciesStats.items))
    .filter(([, weight]) => weight > 0)
    .map(([item, weight]) => ({ item: toId(item), weight: adjustedItemWeight(toId(item), weight, mon, style) }))
    .filter(row => row.weight > 0);
  let item = requiredItem;
  if (item && mon && !itemAllowed(item, mon)) item = undefined;
  if (!item && itemPool.length > 0) item = weighted(itemPool, rng).item;

  const teraPool = Object.entries(asWeights(role.teraTypes))
    .filter(([, weight]) => weight > 0)
    .map(([tera, weight]) => ({ tera, weight }));
  const teraType = teraPool.length ? weighted(teraPool, rng).tera : undefined;
  return createSet(species, level, moves, ability, item, teraType);
}

export function itemAllowed(itemId: string, mon: FoeMon | undefined): boolean {
  if (!mon) return true;
  if (mon.statusMove && itemId === 'assaultvest') return false;
  if (hasStatusMove(mon) && itemId === 'assaultvest') return false;
  if (mon.hazardChip && itemId === 'heavydutyboots') return false;
  return true;
}

function adjustedItemWeight(itemId: string, weight: number, mon: FoeMon | undefined, style: OpponentStyle): number {
  if (!itemAllowed(itemId, mon)) return 0;
  let next = weight;
  if (style === 'aggressive') {
    if (OFFENSE_ITEMS.has(itemId)) next *= 1.6;
    if (STALL_ITEMS.has(itemId)) next *= 0.55;
  } else if (style === 'stall') {
    if (STALL_ITEMS.has(itemId)) next *= 1.6;
    if (OFFENSE_ITEMS.has(itemId)) next *= 0.45;
  }
  if (itemId === 'choicescarf' && mon?.speed === 'slower') next *= 0.2;
  if (itemId === 'choicescarf' && mon?.speed === 'faster') next *= 1.4;
  return next;
}

function hasStatusMove(mon: FoeMon): boolean {
  if (mon.statusMove) return true;
  return (mon.moves || []).some(move => {
    const entry = Dex.moves.get(move);
    return entry.exists && entry.category === 'Status';
  });
}

function roleBias(role: RoleData, style: OpponentStyle): number {
  if (style === 'balanced') return 1;
  const moves = asWeights(role.moves);
  let status = 0;
  let total = 0;
  for (const [move, weight] of Object.entries(moves)) {
    total += weight;
    const entry = Dex.moves.get(move);
    if (entry.exists && entry.category === 'Status') status += weight;
  }
  const share = total > 0 ? status / total : 0;
  return style === 'stall' ? 0.55 + share : 0.55 + (1 - share);
}

function speciesWeight(species: SpeciesStats): number {
  const roles = allRoles(species);
  const total = roles.reduce((sum, role) => sum + role.weight, 0);
  return total > 0 ? total : 1;
}

export function asWeights(value: unknown): Record<string, number> {
  if (!value) return {};
  if (Array.isArray(value)) {
    const out: Record<string, number> = {};
    value.forEach((entry, index) => {
      if (typeof entry === 'string' && entry) out[toId(entry)] = Math.max(1, value.length - index);
    });
    return out;
  }
  if (typeof value !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const weight = typeof raw === 'number' ? raw : Number(raw);
    if (key && Number.isFinite(weight) && weight > 0) out[toId(key)] = weight;
  }
  return out;
}

function createSet(
  species: string,
  level: number,
  moves: string[],
  ability?: string,
  item?: string,
  teraType?: string,
): PokemonSet | null {
  const dexSpecies = Dex.species.get(species);
  if (!dexSpecies.exists) return null;
  const moveNames = moves
    .map(move => Dex.moves.get(move))
    .filter(move => move.exists)
    .map(move => move.name)
    .slice(0, 4);
  if (moveNames.length === 0) moveNames.push('Tackle');
  const abilityName = ability ? Dex.abilities.get(ability).name : '';
  const itemName = item ? Dex.items.get(item).name : '';
  const tera = teraType ? Dex.types.get(teraType).name : '';
  return {
    species: dexSpecies.name,
    moves: moveNames,
    ability: abilityName || dexSpecies.abilities?.['0'] || 'Pressure',
    item: itemName || '',
    nature: 'Hardy',
    evs: { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 },
    level: level || 80,
    ...(tera ? { teraType: tera } : {}),
  } as PokemonSet;
}

function lookupSpecies(stats: RandbatsStats, species: string): SpeciesStats | undefined {
  if (stats[species]) return stats[species];
  const id = toId(species);
  for (const [name, row] of Object.entries(stats)) {
    if (toId(name) === id) return row;
  }
  return undefined;
}

function isFillerMove(id: string): boolean {
  return id === 'tackle' || id === 'splash' || id === 'struggle';
}

function weighted<T extends { weight: number }>(items: T[], rng: PRNG): T {
  return items[weightedIndex(items.map(item => item.weight), rng)];
}

function weightedIndex(weights: number[], rng: PRNG): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return rng.random(weights.length);
  let cursor = (rng.random(1_000_000) / 1_000_000) * total;
  for (let i = 0; i < weights.length; i++) {
    cursor -= weights[i];
    if (cursor <= 0) return i;
  }
  return weights.length - 1;
}

function dedupe(worlds: WorldSample[]): WorldSample[] {
  const map = new Map<string, WorldSample>();
  for (const world of worlds) {
    const key = world.foeTeam
      .map(set => `${set.species}:${(set.moves || []).join(',')}:${set.ability}:${set.item}`)
      .join('|');
    const existing = map.get(key);
    if (existing) existing.weight += world.weight;
    else map.set(key, { ...world });
  }
  const result = [...map.values()];
  const total = result.reduce((sum, world) => sum + world.weight, 0);
  if (total > 0) {
    for (const world of result) world.weight /= total;
  }
  return result;
}

function toId(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
