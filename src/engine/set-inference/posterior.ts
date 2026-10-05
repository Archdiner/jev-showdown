import type { RandbatsStats, RoleData, SpeciesStats } from '../../types/index.js';
import {
  abilityTable,
  canonicalTable,
  containsAll,
  itemTable,
  lookupSpecies,
  moveSetDistribution,
  toId,
} from './catalog.js';

export interface Mass {
  value: string;
  probability: number;
}

export interface MonEvidence {
  species: string;
  level: number;
  revealedMoves: string[];
  revealedAbility?: string;
  revealedItem?: string;
  revealedTera?: string;
  /** P(evidence | item). Missing keys are 1. Zero eliminates the item. */
  itemLikelihood: Map<string, number>;
  abilityLikelihood: Map<string, number>;
  /** Role names that team generation has ruled out for this slot. */
  bannedRoles: Set<string>;
}

export interface RoleMass {
  role: string;
  data: RoleData;
  probability: number;
}

export function emptyEvidence(species: string, level: number): MonEvidence {
  return {
    species,
    level,
    revealedMoves: [],
    itemLikelihood: new Map(),
    abilityLikelihood: new Map(),
    bannedRoles: new Set(),
  };
}

export function rolePosterior(stats: RandbatsStats, mon: MonEvidence, priorOnly: boolean): RoleMass[] {
  const found = lookupSpecies(stats, mon.species);
  if (!found) return [];
  const rows: Array<{ role: string; data: RoleData; log: number }> = [];
  for (const [role, data] of Object.entries(found.table.roles || {})) {
    if ((data.weight || 0) <= 0) continue;
    if (mon.bannedRoles.has(role)) continue;
    const log = Math.log(data.weight) + (priorOnly ? 0 : evidenceLog(found.table, data, mon));
    if (!Number.isFinite(log)) continue;
    rows.push({ role, data, log });
  }
  if (rows.length === 0) return [];
  return softmax(rows);
}

function evidenceLog(species: SpeciesStats, role: RoleData, mon: MonEvidence): number {
  let log = 0;
  const moves = moveSetDistribution(role.moves || {}, []);
  if (mon.revealedMoves.length > 0) {
    if (!moves) return Number.NEGATIVE_INFINITY;
    const hit = moves.probs.reduce((sum, prob, index) => (
      containsAll(moves.sets[index], mon.revealedMoves) ? sum + prob : sum
    ), 0);
    if (hit <= 0) return Number.NEGATIVE_INFINITY;
    log += Math.log(hit);
  }
  const itemMarginal = channelMarginal(itemTable(role, species), mon.revealedItem, mon.itemLikelihood, 'items');
  if (itemMarginal <= 0) return Number.NEGATIVE_INFINITY;
  log += Math.log(itemMarginal);
  const abilityMarginal = channelMarginal(abilityTable(role, species), mon.revealedAbility, mon.abilityLikelihood, 'abilities');
  if (abilityMarginal <= 0) return Number.NEGATIVE_INFINITY;
  log += Math.log(abilityMarginal);
  if (mon.revealedTera) {
    const tera = channelMarginal(role.teraTypes || {}, mon.revealedTera, new Map(), 'types');
    if (tera <= 0) return Number.NEGATIVE_INFINITY;
    log += Math.log(tera);
  }
  return log;
}

/**
 * P(evidence | channel). With no evidence this is 1, so the role prior is unchanged.
 * A revealed value is a hard observation. Soft likelihoods are P(data | value).
 */
function channelMarginal(
  table: Record<string, number>,
  revealed: string | undefined,
  likelihood: Map<string, number>,
  kind: 'items' | 'abilities' | 'types',
): number {
  const rows = canonicalTable(table, kind);
  if (rows.length === 0) return revealed || likelihood.size > 0 ? 0 : 1;
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  if (total <= 0) return 0;
  let weighted = 0;
  for (const row of rows) {
    if (revealed && toId(row.name) !== toId(revealed)) continue;
    const lik = likelihood.get(toId(row.name)) ?? 1;
    weighted += row.weight * lik;
  }
  return weighted / total;
}

export function channelDistribution(
  stats: RandbatsStats,
  mon: MonEvidence,
  kind: 'items' | 'abilities' | 'tera',
  priorOnly: boolean,
): Mass[] {
  const found = lookupSpecies(stats, mon.species);
  if (!found) return point(kind === 'items' ? mon.revealedItem : kind === 'abilities' ? mon.revealedAbility : mon.revealedTera);
  const revealed = kind === 'items' ? mon.revealedItem : kind === 'abilities' ? mon.revealedAbility : mon.revealedTera;
  const roles = rolePosterior(stats, mon, priorOnly);
  if (roles.length === 0) return point(revealed);
  const mixed = new Map<string, number>();
  for (const role of roles) {
    const table = kind === 'items'
      ? itemTable(role.data, found.table)
      : kind === 'abilities'
        ? abilityTable(role.data, found.table)
        : role.data.teraTypes || {};
    const channel = kind === 'items' ? 'items' : kind === 'abilities' ? 'abilities' : 'types';
    const likelihood = priorOnly ? new Map<string, number>() : kind === 'items' ? mon.itemLikelihood : kind === 'abilities' ? mon.abilityLikelihood : new Map<string, number>();
    const rows = conditionalRows(table, revealed, likelihood, channel);
    for (const row of rows) mixed.set(row.name, (mixed.get(row.name) || 0) + role.probability * row.probability);
  }
  return normalizeMass([...mixed.entries()].map(([value, probability]) => ({ value, probability })));
}

function conditionalRows(
  table: Record<string, number>,
  revealed: string | undefined,
  likelihood: Map<string, number>,
  kind: 'items' | 'abilities' | 'types',
): Array<{ name: string; probability: number }> {
  const rows = canonicalTable(table, kind).map(row => ({
    name: row.name,
    weight: row.weight * (revealed && toId(row.name) !== toId(revealed) ? 0 : (likelihood.get(toId(row.name)) ?? 1)),
  })).filter(row => row.weight > 0);
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  if (total <= 0) return [];
  return rows.map(row => ({ name: row.name, probability: row.weight / total }));
}

/** P(move is on the set | evidence). Not a simplex. */
export function moveInclusion(stats: RandbatsStats, mon: MonEvidence, priorOnly: boolean): Map<string, number> {
  const found = lookupSpecies(stats, mon.species);
  const out = new Map<string, number>();
  if (!found) return out;
  const roles = rolePosterior(stats, mon, priorOnly);
  for (const role of roles) {
    const dist = moveSetDistribution(role.data.moves || {}, priorOnly ? [] : mon.revealedMoves);
    if (!dist) continue;
    for (let i = 0; i < dist.sets.length; i++) {
      for (const move of dist.sets[i]) {
        out.set(move, (out.get(move) || 0) + role.probability * dist.probs[i]);
      }
    }
  }
  return out;
}

/**
 * Simplex over moves not yet revealed. This is the predictive distribution
 * for the next move that shows up in the log.
 */
export function nextMoveDistribution(stats: RandbatsStats, mon: MonEvidence, priorOnly: boolean): Mass[] {
  const inclusion = moveInclusion(stats, mon, priorOnly);
  const seen = new Set(mon.revealedMoves.map(move => toId(move)));
  const rows: Mass[] = [];
  for (const [value, probability] of inclusion) {
    if (seen.has(toId(value)) || probability <= 0) continue;
    rows.push({ value, probability });
  }
  return normalizeMass(rows);
}

export function probabilityOf(rows: Mass[], value: string | undefined): number {
  if (!value) return 0;
  const id = toId(value);
  return rows.find(row => toId(row.value) === id)?.probability ?? 0;
}

export function topOf(rows: Mass[]): string {
  return [...rows].sort((a, b) => b.probability - a.probability || a.value.localeCompare(b.value))[0]?.value || '';
}

function softmax(rows: Array<{ role: string; data: RoleData; log: number }>): RoleMass[] {
  const max = Math.max(...rows.map(row => row.log));
  const weights = rows.map(row => Math.exp(row.log - max));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return rows.map((row, index) => ({
    role: row.role,
    data: row.data,
    probability: total > 0 ? weights[index] / total : 1 / rows.length,
  }));
}

function normalizeMass(rows: Mass[]): Mass[] {
  const total = rows.reduce((sum, row) => sum + row.probability, 0);
  if (total <= 0) return [];
  return rows
    .map(row => ({ value: row.value, probability: row.probability / total }))
    .filter(row => row.probability > 0)
    .sort((a, b) => b.probability - a.probability || a.value.localeCompare(b.value));
}

function point(value: string | undefined): Mass[] {
  return value ? [{ value, probability: 1 }] : [];
}

export function multiplyLikelihood(map: Map<string, number>, name: string, factor: number): void {
  const id = toId(name);
  map.set(id, (map.get(id) ?? 1) * factor);
}
