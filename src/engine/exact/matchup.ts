import { Battle, Dex, Teams } from '@pkmn/sim';
import { Pokemon as CalcPokemon } from '@smogon/calc';
import { expectedDamage } from './max-damage.js';
import { SideId, ensureGenerators, legalChoices } from './battle-utils.js';

/**
 * Features for the switch model. Locked before any held-out score:
 * bias, how hard they hit us, how hard we hit them, who is faster,
 * whether a benched mon of ours has a better margin, hazard chip on
 * entry, and both HP fractions. No species indicators.
 */
export const SWITCH_FEATURES = ['bias', 'foeThreat', 'ourThreat', 'outspeed', 'benchMargin', 'hazard', 'ourHp', 'foeHp'] as const;

export interface SwitchFeatureInput {
  foeThreat: number;
  ourThreat: number;
  outspeed: boolean;
  benchMargin: number;
  hazard: number;
  ourHpFrac: number;
  foeHpFrac: number;
}

const NEUTRAL_EVS = { hp: 84, atk: 84, def: 84, spa: 84, spd: 84, spe: 84 };
const NEUTRAL_IVS = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };

let sets: Record<string, { level?: number; sets?: Array<{ movepool?: string[] }> }> | null = null;

function randbats(): typeof sets {
  if (sets) return sets;
  ensureGenerators();
  const gen = Teams.getGenerator('gen9randombattle') as any;
  sets = gen.randomSets || {};
  return sets;
}

export function speciesLevel(species: string, fallback = 80): number {
  const data = randbats()?.[species];
  return data?.level || fallback;
}

export function likelyMoves(species: string, revealed: string[]): string[] {
  const known = revealed.filter(Boolean);
  if (known.length > 0) return known;
  const pool = randbats()?.[species]?.sets?.[0]?.movepool || [];
  const ranked = pool
    .map(id => ({ id, bp: Dex.moves.get(id).basePower || 0 }))
    .sort((a, b) => b.bp - a.bp || a.id.localeCompare(b.id));
  const damaging = ranked.filter(move => move.bp > 0).slice(0, 4);
  const picked = damaging.length > 0 ? damaging : ranked.slice(0, 4);
  return picked.map(move => move.id);
}

const maxHpCache = new Map<string, number>();

export function estimatedMaxHp(species: string, level: number): number {
  const key = `${species}|${level}`;
  const cached = maxHpCache.get(key);
  if (cached) return cached;
  const mon = new CalcPokemon(9, species, { level, evs: NEUTRAL_EVS, ivs: NEUTRAL_IVS });
  const hp = Math.max(1, mon.maxHP());
  maxHpCache.set(key, hp);
  return hp;
}

const damageCache = new Map<string, number>();
/** Pure memo keyed on exact HP; bounded so long runs cannot exhaust memory. */
const DAMAGE_CACHE_CAP = 200_000;

function synth(species: string, level: number, hpFrac: number): any {
  const name = Dex.species.get(species).name || species;
  const maxhp = estimatedMaxHp(name, level);
  const hp = Math.max(1, Math.round(maxhp * Math.max(0, Math.min(1, hpFrac))));
  return {
    species: { name },
    level,
    hp,
    maxhp,
    boosts: {},
    status: '',
    set: {},
  };
}

export function cachedDamage(attacker: any, defender: any, move: string, weather?: string): number {
  const key = [
    attacker.species?.name, attacker.level, attacker.ability, attacker.item, attacker.status, attacker.hp,
    attacker.boosts?.atk, attacker.boosts?.spa,
    defender.species?.name, defender.level, defender.ability, defender.item, defender.status,
    defender.boosts?.def, defender.boosts?.spd,
    move, weather || '',
  ].join('|');
  const hit = damageCache.get(key);
  if (hit !== undefined) return hit;
  const damage = expectedDamage(attacker, defender, move, weather);
  if (damageCache.size >= DAMAGE_CACHE_CAP) damageCache.clear();
  damageCache.set(key, damage);
  return damage;
}

export function bestDamage(attacker: any, defender: any, moves: string[], weather?: string): number {
  let best = 0;
  for (const move of moves) {
    const damage = cachedDamage(attacker, defender, move, weather);
    if (damage > best) best = damage;
  }
  return best;
}

export function threatRatio(damage: number, currentHp: number): number {
  if (currentHp <= 0) return 2;
  return Math.max(0, Math.min(2, damage / currentHp));
}

export function publicSpeed(species: string, level: number): number {
  return (Dex.species.get(species).baseStats?.spe || 0) * level;
}

export function featureVector(input: SwitchFeatureInput): number[] {
  const cap = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));
  return [
    1,
    cap(input.foeThreat, 0, 2),
    cap(input.ourThreat, 0, 2),
    input.outspeed ? 1 : 0,
    cap(input.benchMargin, -2, 2),
    cap(input.hazard, 0, 1),
    cap(input.ourHpFrac, 0, 1),
    cap(input.foeHpFrac, 0, 1),
  ];
}

const SPIKE_FRACTION = [0, 1 / 8, 1 / 6, 1 / 4];

export function isGrounded(pokemon: any): boolean {
  const types: string[] = pokemon.getTypes?.() || pokemon.types || [];
  if (types.some(type => type === 'Flying')) return false;
  const ability = String(pokemon.ability || '');
  if (ability === 'levitate') return false;
  if (pokemon.item === 'airballoon') return false;
  return true;
}

function rockChip(types: string[]): number {
  return (2 ** Dex.getEffectiveness('Rock', types)) / 8;
}

function spikeChip(layers: number): number {
  return SPIKE_FRACTION[Math.min(3, Math.max(0, layers))] || 0;
}

/**
 * Grounded unless the species is Flying or its only ability is Levitate.
 * Replay logs do not reveal the ability, so the fitted hazard feature uses
 * this instead of the live pokemon.
 */
export function publicGrounded(species: string): boolean {
  const dex = Dex.species.get(species);
  const types: string[] = dex.types || [];
  if (types.includes('Flying')) return false;
  const abilities = Object.values(dex.abilities || {}) as string[];
  if (abilities.length > 0 && abilities.every(name => name.toLowerCase() === 'levitate')) return false;
  return true;
}

/** Rocks plus spikes for a species. Shared by the fitter and the live feature. */
export function publicHazardFraction(species: string, rocks: boolean, spikes: number): number {
  const types: string[] = Dex.species.get(species).types || [];
  let fraction = rocks ? rockChip(types) : 0;
  if (spikes > 0 && publicGrounded(species)) fraction += spikeChip(spikes);
  return Math.max(0, Math.min(1, fraction));
}

export function meanBenchHazard(species: string[], rocks: boolean, spikes: number): number {
  if (species.length === 0) return 0;
  let total = 0;
  for (const name of species) total += publicHazardFraction(name, rocks, spikes);
  return total / species.length;
}

/** Fraction of max HP lost by switching this pokemon in. Rocks and spikes only. */
export function hazardFraction(pokemon: any): number {
  const side = pokemon.side;
  if (!side?.sideConditions) return 0;
  let fraction = 0;
  if (side.sideConditions.stealthrock) {
    const types: string[] = pokemon.getTypes?.() || pokemon.types || [];
    fraction += rockChip(types);
  }
  const layers = side.sideConditions.spikes?.layers || 0;
  if (layers > 0 && isGrounded(pokemon)) fraction += spikeChip(layers);
  return Math.max(0, Math.min(1, fraction));
}

function hpFrac(pokemon: any): number {
  if (!pokemon?.maxhp) return 1;
  return Math.max(0, pokemon.hp) / pokemon.maxhp;
}

function revealedMoves(pokemon: any): string[] {
  const slots = pokemon?.moveSlots || [];
  return slots
    .filter((slot: any) => slot && slot.maxpp && slot.pp < slot.maxpp)
    .map((slot: any) => slot.id as string);
}

function knownMoves(pokemon: any, own: boolean): string[] {
  if (own) {
    const slots = (pokemon?.moveSlots || []).map((slot: any) => slot.id as string).filter(Boolean);
    if (slots.length) return slots;
  }
  return likelyMoves(pokemon.species.name, revealedMoves(pokemon));
}

export interface Margin {
  choice: string;
  margin: number;
  species: string;
}

/**
 * Matchup margin for one of our pokemon against their active, using the
 * public estimate (neutral spread, revealed moves or the randbats pool).
 * Positive means we threaten them more than they threaten us.
 */
export function marginAgainst(our: any, foe: any, ownMoves: boolean, weather?: string): number {
  if (!our || !foe || our.fainted) return -2;
  const ourLevel = our.level || speciesLevel(our.species.name);
  const foeLevel = foe.level || speciesLevel(foe.species.name);
  const ourFrac = hpFrac(our);
  const foeFrac = hpFrac(foe);
  const ourSynth = synth(our.species.name, ourLevel, ourFrac);
  const foeSynth = synth(foe.species.name, foeLevel, foeFrac);
  const ourMoves = knownMoves(our, ownMoves);
  const foeMoves = knownMoves(foe, false);
  const ourDmg = bestDamage(ourSynth, foeSynth, ourMoves, weather);
  const foeDmg = bestDamage(foeSynth, ourSynth, foeMoves, weather);
  return threatRatio(ourDmg, foeSynth.hp) - threatRatio(foeDmg, ourSynth.hp);
}

export function switchFeatureInput(battle: Battle, side: SideId): SwitchFeatureInput {
  const us = battle.getSide(side);
  const them = us.foe;
  const active = us.active[0];
  const foe = them.active[0];
  const weather = (battle.field as any).weather?.id as string | undefined;
  const empty: SwitchFeatureInput = {
    foeThreat: 0, ourThreat: 0, outspeed: false, benchMargin: 0, hazard: 0, ourHpFrac: 1, foeHpFrac: 1,
  };
  if (!active || !foe) return empty;

  const ourLevel = active.level || speciesLevel(active.species.name);
  const foeLevel = foe.level || speciesLevel(foe.species.name);
  const ourFrac = hpFrac(active);
  const foeFrac = hpFrac(foe);
  // Revealed moves, or the randbats pool. The replay fit never sees a
  // hidden movepool, so the live feature must not either.
  const ourSynth = synth(active.species.name, ourLevel, ourFrac);
  const foeSynth = synth(foe.species.name, foeLevel, foeFrac);
  const ourDmg = bestDamage(ourSynth, foeSynth, knownMoves(active, false), weather);
  const foeDmg = bestDamage(foeSynth, ourSynth, knownMoves(foe, false), weather);
  const ourThreat = threatRatio(ourDmg, foeSynth.hp);
  const foeThreat = threatRatio(foeDmg, ourSynth.hp);
  const activeMargin = ourThreat - foeThreat;

  let bestBench = activeMargin;
  for (const mon of us.pokemon) {
    if (!mon || mon.fainted || mon.isActive) continue;
    const margin = marginAgainst(mon, foe, false, weather);
    if (margin > bestBench) bestBench = margin;
  }

  return {
    foeThreat,
    ourThreat,
    outspeed: publicSpeed(active.species.name, ourLevel) > publicSpeed(foe.species.name, foeLevel),
    benchMargin: bestBench - activeMargin,
    hazard: benchHazard(us),
    ourHpFrac: ourFrac,
    foeHpFrac: foeFrac,
  };
}

function benchHazard(side: any): number {
  const bench = (side.pokemon || []).filter((mon: any) => mon && !mon.fainted && !mon.isActive);
  const rocks = Boolean(side?.sideConditions?.stealthrock);
  const spikes = side?.sideConditions?.spikes?.layers || 0;
  return meanBenchHazard(bench.map((mon: any) => mon.species.name as string), rocks, spikes);
}

/** Hazard chip a switch onto this side would pay. Uses the active's grounding if present. */
export function hazardOnSide(side: any): number {
  const active = side.active?.[0];
  if (active) return hazardFraction(active);
  const sample = side.pokemon?.find((mon: any) => mon && !mon.fainted);
  return sample ? hazardFraction(sample) : 0;
}

export function rankedSwitches(battle: Battle, side: SideId, knowOwnMoves = true): Margin[] {
  const us = battle.getSide(side);
  const foe = us.foe.active[0];
  const weather = (battle.field as any).weather?.id as string | undefined;
  const legal = new Set(legalChoices(battle, side).filter(choice => choice.startsWith('switch')));
  const ranked: Margin[] = [];
  if (!foe) return ranked;
  for (let i = 0; i < us.pokemon.length; i++) {
    const choice = `switch ${i + 1}`;
    if (!legal.has(choice)) continue;
    const mon = us.pokemon[i];
    ranked.push({
      choice,
      species: mon.species.name,
      margin: marginAgainst(mon, foe, knowOwnMoves, weather) - hazardFraction(mon),
    });
  }
  ranked.sort((a, b) => b.margin - a.margin || a.choice.localeCompare(b.choice));
  return ranked;
}

/** How hard a prior foe hits our species, as a fraction of our HP, capped at 2. */
export function synthThreat(ourSpecies: string, ourLevel: number, foeSpecies: string, foeLevel: number): number {
  const ourSynth = synth(ourSpecies, ourLevel, 1);
  const foeSynth = synth(foeSpecies, foeLevel, 1);
  const damage = bestDamage(foeSynth, ourSynth, likelyMoves(foeSpecies, []));
  return threatRatio(damage, ourSynth.hp);
}

export function publicMatchup(input: {
  ourSpecies: string;
  ourLevel: number;
  ourHpFrac: number;
  ourMoves: string[];
  foeSpecies: string;
  foeLevel: number;
  foeHpFrac: number;
  foeMoves: string[];
  weather?: string;
}): { ourThreat: number; foeThreat: number; outspeed: boolean; margin: number } {
  const ourSynth = synth(input.ourSpecies, input.ourLevel, input.ourHpFrac);
  const foeSynth = synth(input.foeSpecies, input.foeLevel, input.foeHpFrac);
  const ourMoves = input.ourMoves.length ? input.ourMoves : likelyMoves(input.ourSpecies, []);
  const foeMoves = input.foeMoves.length ? input.foeMoves : likelyMoves(input.foeSpecies, []);
  const ourThreat = threatRatio(bestDamage(ourSynth, foeSynth, ourMoves, input.weather), foeSynth.hp);
  const foeThreat = threatRatio(bestDamage(foeSynth, ourSynth, foeMoves, input.weather), ourSynth.hp);
  const outspeed = publicSpeed(input.ourSpecies, input.ourLevel) > publicSpeed(input.foeSpecies, input.foeLevel);
  return { ourThreat, foeThreat, outspeed, margin: ourThreat - foeThreat };
}

export function priorSpecies(count = 24): string[] {
  const keys = Object.keys(randbats() || {}).sort();
  if (keys.length === 0) return [];
  const stride = Math.max(1, Math.floor(keys.length / count));
  const picked: string[] = [];
  for (let i = 0; i < keys.length && picked.length < count; i += stride) picked.push(keys[i]);
  return picked;
}
