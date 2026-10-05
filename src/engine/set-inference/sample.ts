import { Dex } from '@pkmn/sim';
import type { PokemonSet } from '@pkmn/sim';
import type { RandbatsStats } from '../../types/index.js';
import {
  abilityTable,
  baseSpeciesName,
  canonicalTable,
  dexAbilities,
  effectiveness,
  itemTable,
  levelOf,
  lookupSpecies,
  moveSetDistribution,
  pickWeighted,
  speciesTypes,
  spreadFor,
  type StatBlock,
} from './catalog.js';
import {
  channelDistribution,
  rolePosterior,
  type MonEvidence,
} from './posterior.js';

export interface ConcretePokemon {
  species: string;
  level: number;
  role: string;
  moves: string[];
  ability: string;
  item: string;
  teraType: string;
  nature: string;
  evs: StatBlock;
  ivs: StatBlock;
  stats: StatBlock;
  /** True when this slot was not revealed and was drawn from the team prior. */
  placeholder: boolean;
}

export interface OpponentWorld {
  /** Active foe first, then the rest of the team. */
  team: ConcretePokemon[];
  /** Probability of this concrete team under the posterior, normalized across the returned worlds. */
  weight: number;
  tag: string;
}

interface TeamCounts {
  bases: Set<string>;
  types: Map<string, number>;
  weak: Map<string, number>;
  doubleWeak: Map<string, number>;
  freezeDry: number;
  level100: number;
  teraBlast: boolean;
}

const TYPE_NAMES = () => Dex.types.names().filter(name => name !== 'Stellar');

export function sampleWorldsFrom(
  stats: RandbatsStats,
  revealed: MonEvidence[],
  activeSpecies: string | undefined,
  n: number,
  rng: () => number,
  priorOnly: boolean,
): OpponentWorld[] {
  if (n <= 0) return [];
  const ordered = orderRevealed(revealed, activeSpecies);
  const drawn: Array<{ team: ConcretePokemon[]; logp: number; tag: string }> = [];
  for (let i = 0; i < n; i++) {
    const world = sampleOne(stats, ordered, rng, priorOnly);
    if (world) drawn.push(world);
  }
  return mergeWorlds(drawn);
}

function orderRevealed(revealed: MonEvidence[], activeSpecies: string | undefined): MonEvidence[] {
  if (!activeSpecies) return revealed.slice();
  const active = revealed.find(mon => mon.species === activeSpecies);
  if (!active) return revealed.slice();
  return [active, ...revealed.filter(mon => mon !== active)];
}

function sampleOne(
  stats: RandbatsStats,
  revealed: MonEvidence[],
  rng: () => number,
  priorOnly: boolean,
): { team: ConcretePokemon[]; logp: number; tag: string } | null {
  const team: ConcretePokemon[] = [];
  const counts = emptyCounts();
  let logp = 0;
  const tags: string[] = [];
  for (const mon of revealed) {
    const sampled = sampleMon(stats, mon, rng, priorOnly, false);
    if (!sampled) return null;
    team.push(sampled.mon);
    logp += sampled.logp;
    tags.push(sampled.mon.species + ':' + sampled.mon.role);
    addCounts(counts, sampled.mon.species, stats, sampled.mon.role);
  }
  while (team.length < 6) {
    const choices = legalSpecies(stats, counts);
    if (choices.length === 0) break;
    const base = choices[Math.floor(rng() * choices.length)];
    const formes = base.formes;
    const species = formes[Math.floor(rng() * formes.length)];
    const p = (1 / choices.length) * (1 / formes.length);
    const table = lookupSpecies(stats, species);
    const mon = emptyHidden(species, levelOf(table?.table, 80), counts.teraBlast);
    const sampled = sampleMon(stats, mon, rng, true, true);
    if (!sampled) break;
    team.push(sampled.mon);
    logp += Math.log(p) + sampled.logp;
    tags.push('?' + sampled.mon.species);
    addCounts(counts, sampled.mon.species, stats, sampled.mon.role);
  }
  if (team.length === 0) return null;
  return { team, logp, tag: tags.join(';') };
}

function emptyHidden(species: string, level: number, teraBlast: boolean): MonEvidence {
  return {
    species,
    level,
    revealedMoves: [],
    itemLikelihood: new Map(),
    abilityLikelihood: new Map(),
    bannedRoles: teraBlast ? new Set(['Tera Blast user']) : new Set(),
  };
}

function sampleMon(
  stats: RandbatsStats,
  mon: MonEvidence,
  rng: () => number,
  priorOnly: boolean,
  placeholder: boolean,
): { mon: ConcretePokemon; logp: number } | null {
  const found = lookupSpecies(stats, mon.species);
  const roles = rolePosterior(stats, mon, priorOnly).filter(role => role.probability > 0);
  if (!found || roles.length === 0) {
    const moves = mon.revealedMoves.length ? mon.revealedMoves.slice(0, 4) : ['Tackle'];
    return {
      logp: 0,
      mon: concrete(mon.species, mon.level, 'unknown', moves, mon.revealedAbility || '', mon.revealedItem || '', mon.revealedTera || '', undefined, undefined, placeholder),
    };
  }
  const role = pickWeighted(roles, row => row.probability, rng);
  const sets = moveSetDistribution(role.data.moves || {}, priorOnly ? [] : mon.revealedMoves);
  const moveIndex = sets && sets.sets.length ? pickIndex(sets.probs, rng) : -1;
  const moveSet = moveIndex >= 0 && sets ? sets.sets[moveIndex] : mon.revealedMoves.slice(0, 4);
  const moveP = moveIndex >= 0 && sets ? sets.probs[moveIndex] : 1;
  const abilityRows = channelDistribution(stats, { ...mon, bannedRoles: new Set() }, 'abilities', priorOnly);
  const itemRows = channelDistribution(stats, mon, 'items', priorOnly);
  const teraRows = channelDistribution(stats, mon, 'tera', priorOnly);
  const ability = mon.revealedAbility || (abilityRows.length ? pickWeighted(abilityRows, row => row.probability, rng).value : firstName(abilityTable(role.data, found.table), 'abilities'));
  const item = mon.revealedItem || (itemRows.length ? pickWeighted(itemRows, row => row.probability, rng).value : firstName(itemTable(role.data, found.table), 'items'));
  const tera = mon.revealedTera || (teraRows.length ? pickWeighted(teraRows, row => row.probability, rng).value : firstName(role.data.teraTypes, 'types'));
  const abilityP = probOf(abilityRows, ability);
  const itemP = probOf(itemRows, item);
  const teraP = probOf(teraRows, tera);
  const logp = Math.log(role.probability) + Math.log(Math.max(moveP, 1e-12)) + Math.log(Math.max(abilityP, 1e-12)) + Math.log(Math.max(itemP, 1e-12)) + Math.log(Math.max(teraP, 1e-12));
  const moves = [...moveSet];
  for (const revealed of mon.revealedMoves) {
    if (!moves.includes(revealed) && moves.length < 4) moves.push(revealed);
  }
  return {
    logp,
    mon: concrete(found.key, levelOf(found.table, mon.level), role.role, moves.slice(0, 4), ability || '', item || '', tera || '', role.data, found.table, placeholder),
  };
}

function concrete(
  species: string,
  level: number,
  role: string,
  moves: string[],
  ability: string,
  item: string,
  teraType: string,
  roleData: RoleDataLike | undefined,
  speciesTable: { evs?: Record<string, number>; ivs?: Record<string, number> } | undefined,
  placeholder: boolean,
): ConcretePokemon {
  const spread = spreadFor(species, level, roleData as never, speciesTable as never);
  if (moves.some(move => move === 'Gyro Ball' || move === 'Trick Room')) {
    spread.evs.spe = 0;
    spread.ivs.spe = 0;
    const base = Dex.species.get(species).baseStats?.spe || 0;
    spread.stats.spe = Math.floor((2 * base * level) / 100 + 5);
  }
  return {
    species,
    level,
    role,
    moves: moves.length ? moves : ['Tackle'],
    ability,
    item,
    teraType,
    nature: 'Serious',
    evs: spread.evs,
    ivs: spread.ivs,
    stats: spread.stats,
    placeholder,
  };
}

interface RoleDataLike {
  evs?: Record<string, number>;
  ivs?: Record<string, number>;
}

function firstName(table: Record<string, number> | undefined, kind: 'abilities' | 'items' | 'types'): string {
  return canonicalTable(table, kind)[0]?.name || '';
}

function probOf(rows: Array<{ value: string; probability: number }>, value: string): number {
  return rows.find(row => row.value === value)?.probability || (rows.length ? 0 : 1);
}

function pickIndex(probs: number[], rng: () => number): number {
  let roll = rng();
  for (let i = 0; i < probs.length; i++) {
    roll -= probs[i];
    if (roll <= 0) return i;
  }
  return probs.length - 1;
}

export function legalSpecies(stats: RandbatsStats, counts: TeamCounts): Array<{ base: string; formes: string[] }> {
  const byBase = new Map<string, string[]>();
  for (const name of Object.keys(stats)) {
    if (!Dex.species.get(name).exists) continue;
    if (!canAdd(stats, name, counts)) continue;
    const base = baseSpeciesName(name);
    const list = byBase.get(base) || [];
    list.push(name);
    byBase.set(base, list);
  }
  return [...byBase.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([base, formes]) => ({ base, formes: formes.sort() }));
}

export function canAdd(stats: RandbatsStats, speciesName: string, counts: TeamCounts): boolean {
  const species = Dex.species.get(speciesName);
  if (!species.exists) return false;
  if (counts.bases.has(species.baseSpecies)) return false;
  for (const type of species.types) {
    if ((counts.types.get(type) || 0) >= 2) return false;
  }
  for (const type of TYPE_NAMES()) {
    const eff = effectiveness(type, speciesName);
    if (eff > 0 && (counts.weak.get(type) || 0) >= 3) return false;
    if (eff > 1 && (counts.doubleWeak.get(type) || 0) >= 1) return false;
  }
  if (countsFireWeak(speciesName) && (counts.weak.get('Fire') || 0) >= 3) return false;
  if (weakToFreezeDry(speciesName) && counts.freezeDry >= 4) return false;
  const table = lookupSpecies(stats, speciesName);
  if ((table?.table.level || 0) === 100 && counts.level100 >= 1) return false;
  if (counts.teraBlast && onlyTeraBlast(table?.table)) return false;
  return true;
}

function onlyTeraBlast(table: { roles?: Record<string, { weight: number }> } | undefined): boolean {
  const roles = Object.entries(table?.roles || {}).filter(([, data]) => (data.weight || 0) > 0);
  return roles.length > 0 && roles.every(([role]) => role === 'Tera Blast user');
}

function countsFireWeak(speciesName: string): boolean {
  if (effectiveness('Fire', speciesName) !== 0) return false;
  return dexAbilities(speciesName).some(ability => ability === 'Dry Skin' || ability === 'Fluffy');
}

function weakToFreezeDry(speciesName: string): boolean {
  const species = Dex.species.get(speciesName);
  if (!species.exists) return false;
  return effectiveness('Ice', speciesName) > 0
    || (effectiveness('Ice', speciesName) > -2 && species.types.includes('Water'));
}

export function emptyCounts(): TeamCounts {
  return {
    bases: new Set(),
    types: new Map(),
    weak: new Map(),
    doubleWeak: new Map(),
    freezeDry: 0,
    level100: 0,
    teraBlast: false,
  };
}

export function addCounts(counts: TeamCounts, speciesName: string, stats: RandbatsStats, role: string): void {
  const species = Dex.species.get(speciesName);
  if (!species.exists) return;
  counts.bases.add(species.baseSpecies);
  for (const type of speciesTypes(speciesName)) counts.types.set(type, (counts.types.get(type) || 0) + 1);
  for (const type of TYPE_NAMES()) {
    const eff = effectiveness(type, speciesName);
    if (eff > 0) counts.weak.set(type, (counts.weak.get(type) || 0) + 1);
    if (eff > 1) counts.doubleWeak.set(type, (counts.doubleWeak.get(type) || 0) + 1);
  }
  if (countsFireWeak(speciesName)) counts.weak.set('Fire', (counts.weak.get('Fire') || 0) + 1);
  if (weakToFreezeDry(speciesName)) counts.freezeDry++;
  const table = lookupSpecies(stats, speciesName);
  if ((table?.table.level || 0) === 100) counts.level100++;
  if (role === 'Tera Blast user') counts.teraBlast = true;
}

function mergeWorlds(worlds: Array<{ team: ConcretePokemon[]; logp: number; tag: string }>): OpponentWorld[] {
  const grouped = new Map<string, { team: ConcretePokemon[]; tag: string; logs: number[] }>();
  for (const world of worlds) {
    const key = world.team.map(mon => [mon.species, mon.role, mon.moves.join(','), mon.ability, mon.item, mon.teraType].join(':')).join('|');
    const existing = grouped.get(key);
    if (existing) existing.logs.push(world.logp);
    else grouped.set(key, { team: world.team, tag: world.tag, logs: [world.logp] });
  }
  const rows = [...grouped.values()];
  if (rows.length === 0) return [];
  const max = Math.max(...rows.map(row => Math.max(...row.logs)));
  const weights = rows.map(row => row.logs.reduce((sum, logp) => sum + Math.exp(logp - max), 0));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return rows.map((row, index) => ({
    team: row.team,
    tag: row.tag,
    weight: total > 0 ? weights[index] / total : 1 / rows.length,
  })).sort((a, b) => b.weight - a.weight || a.tag.localeCompare(b.tag));
}

export function toPokemonSet(mon: ConcretePokemon): PokemonSet {
  return {
    species: mon.species,
    moves: mon.moves,
    ability: mon.ability,
    item: mon.item,
    nature: mon.nature,
    evs: mon.evs,
    ivs: mon.ivs,
    level: mon.level,
    teraType: mon.teraType,
  } as PokemonSet;
}

export function teammateDistribution(
  stats: RandbatsStats,
  revealed: Array<{ species: string; role: string }>,
): Array<{ value: string; probability: number }> {
  const counts = emptyCounts();
  for (const mon of revealed) addCounts(counts, mon.species, stats, mon.role);
  const legal = legalSpecies(stats, counts);
  if (legal.length === 0) return [];
  const rows: Array<{ value: string; probability: number }> = [];
  for (const group of legal) {
    for (const forme of group.formes) {
      rows.push({ value: forme, probability: (1 / legal.length) * (1 / group.formes.length) });
    }
  }
  return rows.sort((a, b) => b.probability - a.probability || a.value.localeCompare(b.value));
}
