import { Dex, PRNG, PokemonSet } from '@pkmn/sim';
import { RandbatsStats, SpeciesStats, RoleData } from '../../types/index.js';
import { FoeMon } from '../../client/decision-battle.js';

/** Minimum randbats species count. Fail loudly if the data is a stub. */
const MIN_SPECIES_COUNT = 400;

/** Randbats team size. */
export const TEAM_SIZE = 6;

export interface WorldSample {
  /** Full opponent team (active first, then bench). */
  foeTeam: PokemonSet[];
  /** Normalized probability of this world. */
  weight: number;
  /** Human-readable label for logging. */
  tag: string;
}

export interface WorldEvidence {
  /** Revealed foe Pokémon (active first). */
  knownFoes: FoeMon[];
  /** Expected team size (default 6). */
  teamSize?: number;
}

interface RoleSample {
  role: string;
  data: RoleData;
  weight: number;
}

/**
 * Sample K plausible opponent worlds from randbats data.
 * Each world is a complete 6-Pokémon team consistent with revealed info.
 */
export function sampleWorlds(
  evidence: WorldEvidence,
  k: number,
  stats: RandbatsStats,
  rng: PRNG,
): WorldSample[] {
  validateStats(stats);
  
  const teamSize = evidence.teamSize ?? TEAM_SIZE;
  const worlds: WorldSample[] = [];
  
  for (let i = 0; i < k; i++) {
    const world = sampleWorld(evidence, teamSize, stats, rng);
    if (world) worlds.push(world);
  }
  
  // Deduplicate and merge weights
  return deduplicateWorlds(worlds);
}

function validateStats(stats: RandbatsStats): void {
  const count = Object.keys(stats).length;
  if (count < MIN_SPECIES_COUNT) {
    throw new Error(
      `Randbats data has only ${count} species (expected ≥${MIN_SPECIES_COUNT}). ` +
      'Run `npm run data:refresh` to fix.'
    );
  }
}

function sampleWorld(
  evidence: WorldEvidence,
  teamSize: number,
  stats: RandbatsStats,
  rng: PRNG,
): WorldSample | null {
  const foeTeam: PokemonSet[] = [];
  const tags: string[] = [];
  let logProb = 0;
  
  const revealedSpecies = new Set(
    evidence.knownFoes.map(mon => toId(mon.species))
  );
  
  // Fill revealed Pokémon
  for (const mon of evidence.knownFoes) {
    const sampled = sampleRevealedMon(mon, stats, rng);
    if (!sampled) return null;
    foeTeam.push(sampled.set);
    tags.push(sampled.tag);
    logProb += sampled.logProb;
  }
  
  // Fill unrevealed slots
  const need = teamSize - foeTeam.length;
  for (let i = 0; i < need; i++) {
    const sampled = sampleUnrevealedMon(revealedSpecies, stats, rng);
    if (!sampled) continue;
    foeTeam.push(sampled.set);
    revealedSpecies.add(toId(sampled.set.species));
    tags.push(`?${sampled.set.species}`);
    logProb += sampled.logProb;
  }
  
  return {
    foeTeam,
    weight: Math.exp(logProb),
    tag: tags.join(';'),
  };
}

interface SampledMon {
  set: PokemonSet;
  tag: string;
  logProb: number;
}

function sampleRevealedMon(
  mon: FoeMon,
  stats: RandbatsStats,
  rng: PRNG,
): SampledMon | null {
  const speciesStats = stats[mon.species];
  if (!speciesStats) {
    // Species not in randbats data, use revealed info as-is
    const set = createSet(mon.species, mon.level, mon.moves, mon.ability, mon.item);
    if (!set) return null;
    return { set, tag: mon.species, logProb: 0 };
  }
  
  // Filter roles by revealed moves
  const compatibleRoles = filterRolesByMoves(
    speciesStats,
    mon.moves.map(m => toId(m))
  );
  
  if (compatibleRoles.length === 0) {
    // No compatible roles, add revealed moves to any role
    const allRoles = Object.entries(speciesStats.roles || {})
      .map(([name, data]) => ({ role: name, data, weight: data.weight }));
    if (allRoles.length === 0) {
      const set = createSet(mon.species, mon.level, mon.moves, mon.ability, mon.item);
      if (!set) return null;
      return { set, tag: mon.species, logProb: 0 };
    }
    const sampled = weightedSample(allRoles, rng);
    const set = createSetFromRole(
      mon.species,
      speciesStats.level,
      sampled.data,
      speciesStats,
      mon.moves.map(m => toId(m)),
      mon.ability ? toId(mon.ability) : undefined,
      mon.item ? toId(mon.item) : undefined,
      rng,
    );
    if (!set) return null;
    const logProb = Math.log(sampled.weight / allRoles.reduce((sum, r) => sum + r.weight, 0));
    return { set, tag: `${mon.species}:${sampled.role}`, logProb };
  }
  
  const sampled = weightedSample(compatibleRoles, rng);
  const set = createSetFromRole(
    mon.species,
    speciesStats.level,
    sampled.data,
    speciesStats,
    mon.moves.map(m => toId(m)),
    mon.ability ? toId(mon.ability) : undefined,
    mon.item ? toId(mon.item) : undefined,
    rng,
  );
  if (!set) return null;
  
  const totalWeight = compatibleRoles.reduce((sum, r) => sum + r.weight, 0);
  const logProb = Math.log(sampled.weight / totalWeight);
  return { set, tag: `${mon.species}:${sampled.role}`, logProb };
}

function filterRolesByMoves(
  speciesStats: SpeciesStats,
  revealedMoves: string[],
): RoleSample[] {
  const roles: RoleSample[] = [];
  
  for (const [roleName, roleData] of Object.entries(speciesStats.roles || {})) {
    const hasAllMoves = revealedMoves.every(move => {
      const moveData = roleData.moves || {};
      return move in moveData && moveData[move] > 0;
    });
    
    if (hasAllMoves) {
      roles.push({ role: roleName, data: roleData, weight: roleData.weight });
    }
  }
  
  return roles;
}

function sampleUnrevealedMon(
  excludeSpecies: Set<string>,
  stats: RandbatsStats,
  rng: PRNG,
): SampledMon | null {
  const available = Object.entries(stats).filter(
    ([species]) => !excludeSpecies.has(toId(species))
  );
  
  if (available.length === 0) return null;
  
  // Uniform sampling for unrevealed slots (team-gen constraints are future work)
  const [species, speciesStats] = available[rng.random(available.length)];
  
  const roles = Object.entries(speciesStats.roles || {})
    .map(([name, data]) => ({ role: name, data, weight: data.weight }));
  
  if (roles.length === 0) return null;
  
  const sampled = weightedSample(roles, rng);
  const set = createSetFromRole(
    species,
    speciesStats.level,
    sampled.data,
    speciesStats,
    [],
    undefined,
    undefined,
    rng,
  );
  
  if (!set) return null;
  
  // Uniform prior over species, role-weighted within species
  const logProb = Math.log(1 / available.length) + 
                  Math.log(sampled.weight / roles.reduce((sum, r) => sum + r.weight, 0));
  return { set, tag: species, logProb };
}

function createSetFromRole(
  species: string,
  level: number,
  roleData: RoleData,
  speciesStats: SpeciesStats,
  requiredMoves: string[],
  requiredAbility?: string,
  requiredItem?: string,
  rng?: PRNG,
): PokemonSet | null {
  // Sample moves (up to 4, always including required ones)
  const movePool = Object.entries(roleData.moves || {})
    .filter(([, weight]) => weight > 0)
    .map(([move, weight]) => ({ move: toId(move), weight }));
  
  const moves: string[] = [...requiredMoves];
  const usedMoves = new Set(moves);
  
  while (moves.length < 4 && movePool.length > 0) {
    const available = movePool.filter(({ move }) => !usedMoves.has(move));
    if (available.length === 0) break;
    
    const sampled = rng ? weightedSample(available, rng) : available[0];
    moves.push(sampled.move);
    usedMoves.add(sampled.move);
  }
  
  if (moves.length === 0) moves.push('tackle');
  
  // Sample ability (from species level, not role level)
  const abilityPool = Object.entries(speciesStats.abilities || {})
    .filter(([, weight]) => typeof weight === 'number' && weight > 0)
    .map(([ability, weight]) => ({ ability: toId(ability), weight: weight as number }));
  
  let ability = requiredAbility;
  if (!ability && abilityPool.length > 0) {
    const sampled = rng ? weightedSample(abilityPool, rng) : abilityPool[0];
    ability = sampled.ability;
  }
  
  // Sample item
  const itemPool = Object.entries(roleData.items || speciesStats.items || {})
    .filter(([, weight]) => typeof weight === 'number' && weight > 0)
    .map(([item, weight]) => ({ item: toId(item), weight: weight as number }));
  
  let item = requiredItem;
  if (!item && itemPool.length > 0) {
    const sampled = rng ? weightedSample(itemPool, rng) : itemPool[0];
    item = sampled.item;
  }
  
  return createSet(species, level, moves, ability, item);
}

function createSet(
  species: string,
  level: number,
  moves: string[],
  ability?: string,
  item?: string,
): PokemonSet | null {
  const dexSpecies = Dex.species.get(species);
  if (!dexSpecies.exists) return null;
  
  const moveNames = moves
    .map(m => Dex.moves.get(m))
    .filter(m => m.exists)
    .map(m => m.name)
    .slice(0, 4);
  
  if (moveNames.length === 0) moveNames.push('Tackle');
  
  const abilityName = ability ? Dex.abilities.get(ability)?.name : undefined;
  const itemName = item ? Dex.items.get(item)?.name : undefined;
  
  return {
    species: dexSpecies.name,
    moves: moveNames,
    ability: abilityName || dexSpecies.abilities?.['0'] || 'Pressure',
    item: itemName || '',
    nature: 'Hardy',
    evs: { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 },
    level: level || 80,
  } as PokemonSet;
}

function weightedSample<T extends { weight: number }>(
  items: T[],
  rng: PRNG,
): T {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  // PRNG.random(n) returns 0..n-1, so divide by a large number for uniform 0-1
  let r = (rng.random(1000000) / 1000000) * total;
  
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  
  return items[items.length - 1];
}

function deduplicateWorlds(worlds: WorldSample[]): WorldSample[] {
  const map = new Map<string, WorldSample>();
  
  for (const world of worlds) {
    const key = worldKey(world.foeTeam);
    const existing = map.get(key);
    if (existing) {
      existing.weight += world.weight;
    } else {
      map.set(key, { ...world });
    }
  }
  
  const result = Array.from(map.values());
  const totalWeight = result.reduce((sum, w) => sum + w.weight, 0);
  
  if (totalWeight > 0) {
    for (const world of result) {
      world.weight /= totalWeight;
    }
  }
  
  return result;
}

function worldKey(team: PokemonSet[]): string {
  return team
    .map(set => `${set.species}:${set.moves.join(',')}:${set.ability}:${set.item}`)
    .join('|');
}

function toId(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
