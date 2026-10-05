import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { Dex } from '@pkmn/sim';
import { parseReplayLog, ReplayPokemon } from '../client/replay-dataset.js';
import { RandbatsStats, RoleData, SpeciesStats } from '../types/index.js';
import { speciesRolePosterior } from './foe-prior.js';

/** Bump when the counts or the blend stop meaning the same thing. */
export const OBSERVED_PRIORS_VERSION = 1;

/**
 * Pseudo-counts mixed with the public randbats table.
 * Forty is a few dozen games: two reveals move a role by a couple of points,
 * and they cannot replace the base mode.
 */
export const DEFAULT_PRIOR_STRENGTH = 40;

const FULL_SET = 4;

export interface RoleCounts {
  /** Fractional role assignments. */
  n: number;
  /** Fractional assignments where four real moves were revealed. */
  fullSets: number;
  moves: Record<string, number>;
  abilities: Record<string, number>;
  items: Record<string, number>;
  teraTypes: Record<string, number>;
  abilityN: number;
  itemN: number;
  teraN: number;
}

export interface SpeciesCounts {
  n: number;
  /** Revealed moves that no base role lists. Not used as absences. */
  unknownMoves: number;
  roles: Record<string, RoleCounts>;
}

export interface ObservedPriorsFile {
  version: typeof OBSERVED_PRIORS_VERSION;
  priorStrength: number;
  generatedAt: string;
  games: number;
  pokemon: number;
  species: Record<string, SpeciesCounts>;
}

export interface ObservedMon {
  species: string;
  moves: string[];
  ability?: string;
  item?: string;
  teraType?: string;
}

export function emptyObservedPriors(priorStrength = DEFAULT_PRIOR_STRENGTH): ObservedPriorsFile {
  return {
    version: OBSERVED_PRIORS_VERSION,
    priorStrength,
    generatedAt: new Date(0).toISOString(),
    games: 0,
    pokemon: 0,
    species: {},
  };
}

export function observedPriorsPath(): string | null {
  if (process.env.JEV_OBSERVED_PRIORS === '') return null;
  if (process.env.JEV_OBSERVED_PRIORS) return process.env.JEV_OBSERVED_PRIORS;
  return path.join(process.cwd(), 'state', 'meta', 'observed-sets.json');
}

/**
 * Role weights, and move / item / ability / tera frequencies, mixed with
 * ladder reveals. Species with no counts are the base table, same object.
 */
export function blendStats(base: RandbatsStats, observed: ObservedPriorsFile): RandbatsStats {
  if (observed.version !== OBSERVED_PRIORS_VERSION) return base;
  const strength = observed.priorStrength;
  if (!Number.isFinite(strength) || strength <= 0) return base;
  const out: RandbatsStats = { ...base };
  for (const [species, counts] of Object.entries(observed.species || {})) {
    const table = lookup(base, species);
    if (!table || counts.n <= 0) continue;
    out[tableKey(base, species)] = blendSpecies(table, counts, strength);
  }
  return out;
}

export function observeMons(file: ObservedPriorsFile, base: RandbatsStats, mons: ObservedMon[]): number {
  let added = 0;
  for (const mon of mons) {
    if (observeMon(file, base, mon)) added++;
  }
  file.pokemon += added;
  return added;
}

export function readObservedPriors(filePath: string): ObservedPriorsFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ObservedPriorsFile;
    if (!isObservedFile(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeObservedPriors(filePath: string, file: ObservedPriorsFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = { ...file, generatedAt: new Date().toISOString() };
  fs.writeFileSync(filePath, `${JSON.stringify(body, null, 2)}\n`);
  clearObservedPriorCache();
}

let cache: { path: string; mtimeMs: number; base: RandbatsStats; blended: RandbatsStats } | null = null;

/** Base table, or the blended table when a versioned file is present. */
export function applyObservedFile(base: RandbatsStats, filePath?: string | null): RandbatsStats {
  const target = filePath === undefined ? observedPriorsPath() : filePath;
  if (!target || !fs.existsSync(target)) return base;
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(target).mtimeMs;
  } catch {
    return base;
  }
  if (cache && cache.path === target && cache.mtimeMs === mtimeMs && cache.base === base) {
    return cache.blended;
  }
  const parsed = readObservedPriors(target);
  const blended = parsed ? blendStats(base, parsed) : base;
  cache = { path: target, mtimeMs, base, blended };
  return blended;
}

export function clearObservedPriorCache(): void {
  cache = null;
}

export interface RebuildResult {
  file: ObservedPriorsFile;
  filesRead: number;
  skipped: number;
}

/**
 * Walk ladder and live-run logs, count the opponent's revealed sets, and
 * write the versioned file. Our side is not counted.
 */
export function rebuildObservedPriors(options: {
  base: RandbatsStats;
  roots: string[];
  out: string;
  priorStrength?: number;
  username?: string;
}): RebuildResult {
  const file = emptyObservedPriors(options.priorStrength ?? DEFAULT_PRIOR_STRENGTH);
  const sources = readLogSources(options.roots, options.username);
  const seen = new Set<string>();
  let skipped = 0;
  for (const source of sources) {
    const fingerprint = createHash('sha256').update(source.text).digest('hex');
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const mons = opponentMons(source.text, source.username);
    if (!source.username || mons.length === 0) {
      skipped++;
      continue;
    }
    const added = observeMons(file, options.base, mons);
    if (added === 0) {
      skipped++;
      continue;
    }
    file.games += 1;
  }
  writeObservedPriors(options.out, file);
  return { file: readObservedPriors(options.out) || file, filesRead: sources.length, skipped };
}

export function opponentMons(log: string, username: string | null): ObservedMon[] {
  if (!username) return [];
  let row;
  try {
    row = parseReplayLog({ id: 'observed', log });
  } catch {
    return [];
  }
  const id = toID(username);
  const ours = toID(row.p1.name) === id ? row.p1 : toID(row.p2.name) === id ? row.p2 : null;
  if (!ours) return [];
  const foe = ours === row.p1 ? row.p2 : row.p1;
  return foe.pokemon.map(toObserved);
}

interface LogSource {
  text: string;
  username: string | null;
}

export function readLogSources(roots: string[], username?: string): LogSource[] {
  const files: string[] = [];
  for (const root of roots) walk(root, files);
  const hints = new Map<string, string>();
  const embedded: LogSource[] = [];
  const logs: string[] = [];
  for (const file of files) {
    if (file.endsWith('.jsonl')) {
      const text = readCapped(file);
      if (text == null) continue;
      embedded.push(...sourcesFromJsonl(text, hints));
    } else if (file.endsWith('.log')) {
      logs.push(file);
    }
  }
  const sources = embedded.slice();
  for (const file of logs) {
    const text = readCapped(file);
    if (text == null) continue;
    if (!text.includes('|player|') || (!text.includes('|switch|') && !text.includes('|move|'))) continue;
    sources.push({
      text,
      username: username || hints.get(path.basename(file)) || usernameFromFilename(file),
    });
  }
  if (username) {
    for (const source of sources) {
      if (!source.username) source.username = username;
    }
  }
  return sources;
}

function readCapped(file: string): string | null {
  try {
    if (fs.statSync(file).size > 2_000_000) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function sourcesFromJsonl(text: string, hints: Map<string, string>): LogSource[] {
  const sources: LogSource[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const name = typeof row.username === 'string' ? row.username : null;
    const replay = typeof row.localReplayPath === 'string' ? path.basename(row.localReplayPath) : '';
    if (name && replay) hints.set(replay, name);
    const log = typeof row.log === 'string' ? row.log : '';
    if (name && log.includes('|player|')) sources.push({ text: log, username: name });
  }
  return sources;
}

function usernameFromFilename(file: string): string | null {
  const base = path.basename(file);
  const match = /^(.*?)-battle-/i.exec(base);
  return match?.[1] || null;
}

function observeMon(file: ObservedPriorsFile, base: RandbatsStats, mon: ObservedMon): boolean {
  const table = lookup(base, mon.species);
  const key = tableKey(base, mon.species);
  if (!table || !key) return false;
  const moves = canonicalMoves(mon.moves);
  const ability = canonical('abilities', mon.ability);
  const item = canonical('items', mon.item);
  const tera = mon.teraType?.trim() || undefined;
  const counts = file.species[key] || { n: 0, unknownMoves: 0, roles: {} };
  const unknown = moves.filter(move => !moveSupported(table, move));
  if (unknown.length > 0) counts.unknownMoves += unknown.length;
  const posterior = speciesRolePosterior(table, {
    moves,
    ability,
    item,
    teraType: tera,
  });
  if (posterior.length === 0) {
    file.species[key] = counts;
    return false;
  }
  counts.n += 1;
  const full = moves.length >= FULL_SET && unknown.length === 0;
  for (const role of posterior) {
    const bucket = counts.roles[role.role] || emptyRoleCounts();
    bucket.n += role.probability;
    if (full) {
      bucket.fullSets += role.probability;
      for (const move of moves) bucket.moves[move] = (bucket.moves[move] || 0) + role.probability;
    }
    if (ability) {
      bucket.abilityN += role.probability;
      bucket.abilities[ability] = (bucket.abilities[ability] || 0) + role.probability;
    }
    if (item) {
      bucket.itemN += role.probability;
      bucket.items[item] = (bucket.items[item] || 0) + role.probability;
    }
    if (tera) {
      bucket.teraN += role.probability;
      bucket.teraTypes[tera] = (bucket.teraTypes[tera] || 0) + role.probability;
    }
    counts.roles[role.role] = bucket;
  }
  file.species[key] = counts;
  return true;
}

function blendSpecies(table: SpeciesStats, counts: SpeciesCounts, strength: number): SpeciesStats {
  const species: SpeciesStats = JSON.parse(JSON.stringify(table)) as SpeciesStats;
  const n = counts.n;
  for (const [name, role] of Object.entries(species.roles || {})) {
    const observed = counts.roles[name];
    role.weight = ((role.weight || 0) * strength + (observed?.n || 0)) / (strength + n);
    if (!observed) continue;
    if (observed.fullSets > 0) {
      role.moves = blendMap(role.moves, observed.moves, observed.fullSets, strength);
    }
    if (observed.abilityN > 0) {
      const baseAbilities = role.abilities && Object.keys(role.abilities).length > 0
        ? role.abilities
        : species.abilities;
      role.abilities = blendMap(baseAbilities, observed.abilities, observed.abilityN, strength);
    }
    if (observed.itemN > 0) {
      role.items = blendMap(role.items || species.items, observed.items, observed.itemN, strength);
    }
    if (observed.teraN > 0 && role.teraTypes) {
      role.teraTypes = blendMap(role.teraTypes, observed.teraTypes, observed.teraN, strength);
    }
  }
  return species;
}

function blendMap(
  base: Record<string, number> | undefined,
  hits: Record<string, number>,
  n: number,
  strength: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  const keys = new Set([...Object.keys(base || {}), ...Object.keys(hits)]);
  const denom = strength + n;
  for (const key of keys) {
    out[key] = (((base?.[key] || 0) * strength) + (hits[key] || 0)) / denom;
  }
  return out;
}

function moveSupported(table: SpeciesStats, move: string): boolean {
  const id = Dex.moves.get(move).id;
  if (!id) return false;
  return Object.values(table.roles || {}).some(role =>
    Object.entries(role.moves || {}).some(([name, weight]) => weight > 0 && Dex.moves.get(name).id === id),
  );
}

function canonicalMoves(moves: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of moves) {
    const name = canonical('moves', raw);
    if (!name || name === 'Struggle' || name === 'Recharge') continue;
    const id = Dex.moves.get(name).id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(name);
  }
  return out;
}

function canonical(kind: 'moves' | 'abilities' | 'items', raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const entry = Dex[kind].get(raw);
  return entry?.exists ? entry.name : undefined;
}

function lookup(stats: RandbatsStats, species: string): SpeciesStats | undefined {
  if (stats[species]) return stats[species];
  const name = Dex.species.get(species).name;
  if (name && stats[name]) return stats[name];
  return undefined;
}

function tableKey(stats: RandbatsStats, species: string): string {
  if (stats[species]) return species;
  const name = Dex.species.get(species).name;
  if (name && stats[name]) return name;
  return '';
}

function emptyRoleCounts(): RoleCounts {
  return { n: 0, fullSets: 0, moves: {}, abilities: {}, items: {}, teraTypes: {}, abilityN: 0, itemN: 0, teraN: 0 };
}

function toObserved(mon: ReplayPokemon): ObservedMon {
  return {
    species: mon.species,
    moves: mon.moves,
    ability: mon.ability,
    item: mon.item,
    teraType: mon.teraType,
  };
}

function isObservedFile(value: ObservedPriorsFile): boolean {
  return !!value
    && value.version === OBSERVED_PRIORS_VERSION
    && typeof value.priorStrength === 'number'
    && value.priorStrength > 0
    && !!value.species
    && typeof value.species === 'object';
}

function toID(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function walk(dir: string, out: string[]): void {
  if (!dir || !fs.existsSync(dir)) return;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

// RoleData is part of the blended species object. The import keeps the type live for readers.
export type { RoleData };
