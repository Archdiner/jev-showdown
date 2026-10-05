import * as fs from 'fs';
import * as path from 'path';
import { Battle, Dex } from '@pkmn/sim';
import { SideId, otherSide } from './battle-utils.js';
import { damaging, hasCompleteMovepool, writeMoves } from './public.js';
import { MIN_RANDBATS_SPECIES } from './team-features.js';

/**
 * Opt-in foe set prior from the randbats usage dump (data/gen9-stats.json).
 *
 * The decision battle only knows what the protocol revealed: used moves, and
 * an item / ability once it activated. Unknown items are blank and unknown
 * abilities default to the species' first ability. QW's foePrior fills moves
 * from the first randbats set that contains the revealed moves, in movepool
 * order. This prior instead:
 *
 * 1. scores every randbats role by weight x P(revealed move | role) x
 *    P(revealed item | role) x P(revealed ability | role),
 * 2. fills an incomplete movepool with the damaging moves of highest
 *    posterior marginal probability,
 * 3. gives a foe whose item has not been revealed the posterior-mode item,
 *    and one whose ability has not been revealed the posterior-mode ability.
 *
 * Revealed facts are never overwritten. Knowledge of what is hidden comes
 * from markFoeHidden, which buildDecisionBattle calls; a battle without
 * marks (full-info bench, unit fixtures) only gets the move fill.
 */

export interface FoeHidden {
  itemUnknown: boolean;
  abilityUnknown: boolean;
}

const hiddenMarks = new WeakMap<Battle, FoeHidden[]>();

/** Record which foe slots (p2.pokemon order at build time) have hidden item / ability. */
export function markFoeHidden(battle: Battle, rows: FoeHidden[]): void {
  hiddenMarks.set(battle, rows);
}

export function foeHiddenOf(battle: Battle): FoeHidden[] | undefined {
  return hiddenMarks.get(battle);
}

interface RoleStats {
  weight: number;
  abilities?: Record<string, number>;
  items?: Record<string, number>;
  moves?: Record<string, number>;
}

interface SpeciesStats {
  roles?: Record<string, RoleStats>;
}

let statsCache: Record<string, SpeciesStats> | null = null;
const idIndex = new Map<string, string>();

const toId = (text: string) => String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Unit tests inject a small table here instead of touching data/. Pass null to reset. */
export function setUsageStatsForTests(table: Record<string, SpeciesStats> | null): void {
  statsCache = table;
  idIndex.clear();
  for (const key of Object.keys(table || {})) idIndex.set(toId(key), key);
}

/** The usage dump. Refuses a fixture-sized file so a test fixture can never steer a screen. */
export function usageStats(): Record<string, SpeciesStats> {
  if (statsCache) return statsCache;
  const file = path.join(process.cwd(), 'data', 'gen9-stats.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, SpeciesStats>;
  const count = Object.keys(parsed).length;
  if (count < MIN_RANDBATS_SPECIES) {
    throw new Error(`stats prior: data/gen9-stats.json has ${count} species (need >= ${MIN_RANDBATS_SPECIES})`);
  }
  statsCache = parsed;
  for (const key of Object.keys(parsed)) idIndex.set(toId(key), key);
  return parsed;
}

function speciesEntry(mon: any): SpeciesStats | undefined {
  const stats = usageStats();
  const name = mon?.species?.name || '';
  const direct = stats[name] ?? stats[idIndex.get(toId(name)) || ''];
  if (direct) return direct;
  const base = mon?.species?.baseSpecies || '';
  return stats[base] ?? stats[idIndex.get(toId(base)) || ''];
}

function probOf(table: Record<string, number> | undefined, id: string): number | null {
  if (!table) return null;
  for (const [name, prob] of Object.entries(table)) {
    if (toId(name) === id) return prob;
  }
  return 0;
}

export interface RolePosterior {
  role: string;
  prob: number;
  data: RoleStats;
}

/** Normalized role posterior. Falls back to the prior when the evidence rules out every role. */
export function rolePosterior(
  entry: SpeciesStats,
  evidence: { moves: string[]; item?: string; ability?: string },
): RolePosterior[] {
  const roles = Object.entries(entry.roles || {});
  const score = (data: RoleStats, strict: boolean) => {
    let p = data.weight || 0;
    for (const move of evidence.moves) {
      const q = probOf(data.moves, move);
      if (q != null) p *= q > 0 ? q : strict ? 0 : 0.05;
    }
    if (evidence.item) {
      const q = probOf(data.items, evidence.item);
      if (q != null) p *= q > 0 ? q : strict ? 0 : 0.05;
    }
    if (evidence.ability) {
      const q = probOf(data.abilities, evidence.ability);
      if (q != null) p *= q > 0 ? q : strict ? 0 : 0.05;
    }
    return p;
  };
  let rows = roles.map(([role, data]) => ({ role, data, prob: score(data, true) }));
  if (rows.every(row => row.prob <= 0)) rows = roles.map(([role, data]) => ({ role, data, prob: score(data, false) }));
  if (rows.every(row => row.prob <= 0)) rows = roles.map(([role, data]) => ({ role, data, prob: data.weight || 1 }));
  const total = rows.reduce((sum, row) => sum + row.prob, 0) || 1;
  return rows.map(row => ({ ...row, prob: row.prob / total })).sort((a, b) => b.prob - a.prob);
}

function marginal(posterior: RolePosterior[], key: 'moves' | 'items' | 'abilities'): Array<[string, number]> {
  const totals = new Map<string, number>();
  for (const row of posterior) {
    for (const [name, prob] of Object.entries(row.data[key] || {})) {
      totals.set(name, (totals.get(name) || 0) + row.prob * prob);
    }
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export interface StatsPriorOptions {
  /** Fill hidden items with the posterior-mode item. */
  items?: boolean;
  /** Fill hidden abilities with the posterior-mode ability. */
  abilities?: boolean;
  /** Minimum marginal probability for an item / ability fill. */
  minProb?: number;
}

/**
 * Apply the usage prior to the foe of `side` in place. `hidden` lines up with
 * foe.pokemon order (from markFoeHidden on the original decision battle).
 */
export function applyStatsPrior(
  battle: Battle,
  side: SideId,
  hidden: FoeHidden[] | undefined,
  options: StatsPriorOptions = {},
): void {
  const foe = battle.getSide(otherSide(side));
  const minProb = options.minProb ?? 0;
  let changed = false;
  foe.pokemon.forEach((mon: any, index: number) => {
    if (!mon || mon.fainted) return;
    const entry = speciesEntry(mon);
    if (!entry?.roles) return;
    const flags = hidden?.[index];
    const revealedMoves = (mon.moveSlots || [])
      .map((slot: any) => String(slot?.id || ''))
      .filter((id: string) => id && id !== 'tackle' && id !== 'struggle');
    const itemKnown = flags ? !flags.itemUnknown : true;
    const abilityKnown = flags ? !flags.abilityUnknown : true;
    const posterior = rolePosterior(entry, {
      moves: revealedMoves,
      item: itemKnown && mon.item ? toId(mon.item) : undefined,
      ability: abilityKnown && mon.ability ? toId(mon.ability) : undefined,
    });
    if (posterior.length === 0) return;

    if (!hasCompleteMovepool(mon)) {
      const picked = [...revealedMoves];
      for (const [name] of marginal(posterior, 'moves')) {
        if (picked.length >= 4) break;
        const id = toId(name);
        if (!damaging(id) || picked.includes(id)) continue;
        picked.push(id);
      }
      if (picked.length === 0) picked.push('tackle');
      writeMoves(mon, picked.slice(0, 4));
      changed = true;
    }

    if (options.items && flags?.itemUnknown && !mon.item) {
      const [best] = marginal(posterior, 'items');
      const item = best && best[1] >= minProb ? Dex.items.get(best[0]) : null;
      if (item?.exists) {
        mon.item = item.id;
        mon.itemState = (battle as any).initEffectState({ id: item.id, target: mon });
        changed = true;
      }
    }

    if (options.abilities && flags?.abilityUnknown) {
      const [best] = marginal(posterior, 'abilities');
      const ability = best && best[1] >= minProb ? Dex.abilities.get(best[0]) : null;
      if (ability?.exists && ability.id !== 'imposter' && ability.id !== mon.ability) {
        mon.ability = ability.id;
        mon.baseAbility = ability.id;
        mon.abilityState = (battle as any).initEffectState({ id: ability.id, target: mon });
        changed = true;
      }
    }
  });
  if (!changed) return;
  const state = battle.requestState;
  if (state === 'move' || state === 'switch') battle.makeRequest(state);
}

/** Gen 9 Random Battle singles teams are always six. */
export const FOE_TEAM_SIZE = 6;

export interface PlaceholderSet {
  species: string;
  level: number;
  moves: string[];
  item: string;
  ability: string;
}

function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Stand-ins for foe teammates that have not appeared yet, so the decision
 * battle has a full team: knocking out the last revealed foe is no longer a
 * terminal win, and team features (hp / faint differences, matchups) see six
 * foes like the positions the fitted eval was trained on.
 *
 * Species are drawn without replacement from the randbats usage dump,
 * excluding revealed species (species clause), with a seed hashed from the
 * revealed species so a decision is reproducible. Moves / item / ability are
 * the role-prior modes.
 */
export function placeholderSets(seenSpecies: string[], count: number): PlaceholderSet[] {
  if (count <= 0) return [];
  const stats = usageStats();
  const seenIds = new Set(seenSpecies.map(name => toId(Dex.species.get(name).baseSpecies || name)));
  const pool = Object.keys(stats)
    .filter(name => {
      const species = Dex.species.get(name);
      return species.exists && !seenIds.has(toId(species.baseSpecies || name)) && species.name !== 'Ditto';
    })
    .sort();
  let state = hashSeed(seenSpecies.map(toId).sort().join('|')) || 1;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const out: PlaceholderSet[] = [];
  const used = new Set<string>();
  while (out.length < count && pool.length > used.size) {
    const name = pool[Math.floor(next() * pool.length)];
    const base = toId(Dex.species.get(name).baseSpecies || name);
    if (used.has(base)) continue;
    used.add(base);
    const entry = stats[name] as SpeciesStats & { level?: number };
    const posterior = rolePosterior(entry, { moves: [] });
    const moves: string[] = [];
    for (const [move] of marginal(posterior, 'moves')) {
      if (moves.length >= 4) break;
      const id = toId(move);
      if (damaging(id) && !moves.includes(id)) moves.push(id);
    }
    const [item] = marginal(posterior, 'items');
    const [ability] = marginal(posterior, 'abilities');
    out.push({
      species: name,
      level: entry.level || 80,
      moves: moves.length ? moves : ['tackle'],
      item: item?.[0] || '',
      ability: ability && toId(ability[0]) !== 'imposter' ? ability[0] : '',
    });
  }
  return out;
}
