import { Dex } from '@pkmn/sim';
import type { RandbatsStats } from '../types/index.js';
import { SetInference, type OurSet, type StatBlock } from '../engine/set-inference/index.js';
import { lookupSpecies, randbatsStat } from '../engine/set-inference/catalog.js';
import { damaging } from '../engine/exact/public.js';
import { usageStats } from '../engine/exact/stats-prior.js';
import { MIN_RANDBATS_SPECIES } from '../engine/exact/team-features.js';
import type { FoeMon, LivePosition } from './decision-battle.js';

/**
 * Opt-in belief tightening for the decision battle (search param foeBelief).
 *
 * The default decision battle knows only what the protocol revealed, and
 * QW's foePrior fills the rest of a movepool from the first randbats set that
 * contains the revealed moves. With foeBelief, SetInference replays this
 * side's viewer log with the belief updater on: role posterior from revealed
 * moves / item / ability / Tera, hard filters (status move => no Assault
 * Vest, two moves in one stint => no Choice, hazard damage => no Boots,
 * missed Leftovers), same-priority speed order (Scarf yes/no), damage-roll
 * likelihoods for the item, and weather duration (extension rock). Each
 * revealed foe is then filled from that posterior:
 *
 * - moves: the revealed moves plus the most likely damaging moves, up to four;
 * - item: the posterior-mode item when the item is still hidden and the mode
 *   has more than `minProb` mass (0.5: a strict majority, so no coin flips);
 * - ability: the same, for a hidden ability.
 *
 * Revealed facts are never overwritten. Unset, nothing here runs.
 */

export interface BeliefFill {
  /** SetInference key (randbats species name). */
  species: string;
  moves: string[];
  item?: string;
  itemProb?: number;
  ability?: string;
  abilityProb?: number;
}

export interface FoeBeliefOptions {
  /** An item / ability is filled only when its posterior mass is above this (strict majority by default). */
  minProb?: number;
  /** Randbats table. Omit for data/gen9-stats.json (refuses a fixture-sized file). */
  stats?: RandbatsStats;
}

const DEFAULT_MIN_PROB = 0.5;
const toId = (text: string | undefined) => String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** The production table. Throws on fewer than MIN_RANDBATS_SPECIES species. */
export function beliefStats(): RandbatsStats {
  const stats = usageStats() as unknown as RandbatsStats;
  const count = Object.keys(stats).length;
  if (count < MIN_RANDBATS_SPECIES) throw new Error(`foe belief: ${count} randbats species (need >= ${MIN_RANDBATS_SPECIES})`);
  return stats;
}

const EV_IV_CANDIDATES: Array<[number, number]> = [[85, 31], [0, 0], [85, 0], [0, 31], [84, 31], [84, 0]];

/** EV/IV per stat that reproduces the request's computed stat (randbats spreads are neutral-nature). */
function spreadFromRequest(species: string, level: number, stats: Record<string, number> | undefined): { evs: StatBlock; ivs: StatBlock } {
  const evs: StatBlock = { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 };
  const ivs: StatBlock = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
  const dex = Dex.species.get(species);
  if (!dex.exists || !stats) return { evs, ivs };
  for (const key of ['atk', 'def', 'spa', 'spd', 'spe'] as const) {
    const target = stats[key];
    if (typeof target !== 'number') continue;
    const hit = EV_IV_CANDIDATES.find(([ev, iv]) => randbatsStat(dex.baseStats[key], level, ev, iv) === target);
    if (hit) {
      evs[key] = hit[0];
      ivs[key] = hit[1];
    }
  }
  return { evs, ivs };
}

/** Our team from a `|request|`, as SetInference needs it for speed and damage evidence. */
export function ourTeamFromRequest(request: any): OurSet[] {
  const slots: any[] = request?.side?.pokemon || [];
  const out: OurSet[] = [];
  for (const slot of slots) {
    const details = String(slot?.details || '');
    const species = details.split(',')[0]?.trim() || String(slot?.ident || '').split(':').slice(1).join(':').trim();
    if (!species) continue;
    const level = Number(details.match(/L(\d+)/)?.[1] || 100);
    const { evs, ivs } = spreadFromRequest(species, level, slot?.stats);
    out.push({
      species,
      level,
      ability: slot?.ability || slot?.baseAbility || undefined,
      item: slot?.item || undefined,
      evs,
      ivs,
    });
  }
  return out;
}

/**
 * Incremental posterior for one viewer of one battle. Feed the viewer log in
 * order (the log only grows); `fills()` reads the current posterior.
 */
export class FoeBeliefSession {
  private readonly inference: SetInference;
  private consumed = 0;
  private teamKey = '';
  /** Set after an update throws: the rest of the battle decides without the fill. */
  failed = false;

  constructor(
    private readonly side: 'p1' | 'p2',
    private readonly options: FoeBeliefOptions = {},
  ) {
    this.inference = new SetInference(options.stats ?? beliefStats(), {
      ourSide: () => side,
      seed: 1,
      beliefUpdaterEnabled: true,
    });
  }

  /** Apply viewer lines not seen yet. `lines` is this side's whole viewer log so far. */
  update(lines: readonly string[], request?: unknown): void {
    if (this.failed) return;
    try {
      if (request) this.attachTeam(request);
      if (lines.length < this.consumed) throw new Error('foe belief: viewer log shrank');
      for (let i = this.consumed; i < lines.length; i++) this.inference.observe(lines[i]);
      this.consumed = lines.length;
    } catch (err) {
      this.failed = true;
      throw err;
    }
  }

  inferenceForTests(): SetInference {
    return this.inference;
  }

  fills(): BeliefFill[] {
    if (this.failed) return [];
    const minProb = this.options.minProb ?? DEFAULT_MIN_PROB;
    const out: BeliefFill[] = [];
    for (const species of this.inference.foeSpecies()) {
      const mon = this.inference.getMonEvidence(species);
      if (!mon) continue;
      const revealed = mon.revealedMoves.map(toId).filter(Boolean);
      const moves = [...revealed];
      const ranked = this.inference.moveInclusion(species)
        .sort((a, b) => b.probability - a.probability || a.value.localeCompare(b.value));
      for (const row of ranked) {
        if (moves.length >= 4) break;
        const id = toId(row.value);
        if (!id || moves.includes(id) || !damaging(id)) continue;
        moves.push(id);
      }
      const fill: BeliefFill = { species, moves };
      const [item] = this.inference.itemDistribution(species);
      if (item && item.probability > minProb && Dex.items.get(item.value).exists) {
        fill.item = Dex.items.get(item.value).name;
        fill.itemProb = item.probability;
      }
      const [ability] = this.inference.abilityDistribution(species);
      if (ability && ability.probability > minProb && Dex.abilities.get(ability.value).exists && toId(ability.value) !== 'imposter') {
        fill.ability = Dex.abilities.get(ability.value).name;
        fill.abilityProb = ability.probability;
      }
      out.push(fill);
    }
    return out;
  }

  private attachTeam(request: unknown): void {
    const team = ourTeamFromRequest(request);
    const key = team.map(mon => `${mon.species}|${mon.item || ''}|${mon.ability || ''}`).join(';');
    if (key === this.teamKey) return;
    this.teamKey = key;
    this.inference.attachOurTeam(team);
  }
}

function fillKey(stats: RandbatsStats | undefined, species: string): string {
  const table = stats ?? beliefStats();
  return lookupSpecies(table, species)?.key || Dex.species.get(species).name || species;
}

function fillMon(mon: FoeMon, fill: BeliefFill | undefined): FoeMon {
  if (!fill) return mon;
  const next: FoeMon = { ...mon };
  const known = (mon.moves || []).map(toId).filter(id => id && id !== 'struggle');
  if (known.length < 4) {
    const moves = [...known];
    for (const id of fill.moves) {
      if (moves.length >= 4) break;
      if (!moves.includes(id)) moves.push(id);
    }
    next.moves = moves;
  }
  if (mon.itemUnknown === true && !mon.item && fill.item) next.item = fill.item;
  if (mon.abilityUnknown === true && !mon.ability && fill.ability) next.ability = fill.ability;
  return next;
}

/** The position with every revealed foe filled from `fills`. Matching is by randbats species key. */
export function applyFoeBelief(position: LivePosition, fills: BeliefFill[], stats?: RandbatsStats): LivePosition {
  if (fills.length === 0) return position;
  const byKey = new Map(fills.map(fill => [fill.species, fill]));
  const find = (mon: FoeMon) => byKey.get(fillKey(stats, mon.species));
  return {
    ...position,
    foeActive: position.foeActive ? fillMon(position.foeActive, find(position.foeActive)) : null,
    foeBench: position.foeBench.map(mon => fillMon(mon, find(mon))),
  };
}
