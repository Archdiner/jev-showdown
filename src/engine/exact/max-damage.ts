import { Battle, Dex } from '@pkmn/sim';
import { calculate, Pokemon as CalcPokemon, Move, Field } from '@smogon/calc';
import { SideId, legalChoices, moveSlotIndex } from './battle-utils.js';

const WEATHER: Record<string, 'Sun' | 'Rain' | 'Sand' | 'Snow'> = {
  sunnyday: 'Sun',
  raindance: 'Rain',
  sandstorm: 'Sand',
  snow: 'Snow',
  hail: 'Snow',
};

function averageDamage(damage: number | number[] | number[][]): number {
  if (typeof damage === 'number') return damage;
  const flat = (damage as number[]).flat(2) as number[];
  if (!flat.length) return 0;
  return flat.reduce((sum, n) => sum + n, 0) / flat.length;
}

/** The roll chart for one damaging move. Multi-hit uses the fullest hit row. */
export function damageRollChart(damage: unknown): number[] {
  if (typeof damage === 'number') return [damage];
  if (!Array.isArray(damage) || damage.length === 0) return [];
  if (Array.isArray(damage[0])) {
    const rows = damage as number[][];
    const fullest = rows.reduce((best, row) => (row.length > best.length ? row : best), rows[0]);
    return fullest.filter(value => typeof value === 'number');
  }
  return (damage as unknown[]).filter((value): value is number => typeof value === 'number');
}

/**
 * Damage rolls from @smogon/calc. Null when the move is status or has no base power.
 */
export function damageRolls(attacker: any, defender: any, moveName: string, weatherId?: string): number[] | null {
  try {
    const move = new Move(9, moveName);
    if (move.category === 'Status' || !move.bp) return null;
    const weather = weatherId ? WEATHER[weatherId] : undefined;
    const field = new Field(weather ? { weather } : {});
    const result = calculate(9, calcMon(attacker), calcMon(defender), move, field);
    const rolls = damageRollChart(result.damage);
    return rolls.length ? rolls : null;
  } catch {
    return null;
  }
}

function dexName(kind: 'abilities' | 'items' | 'natures', raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const entry = Dex[kind].get(raw);
  return entry?.exists ? entry.name : raw;
}

const calcSpeciesCache = new Map<string, string>();

/**
 * Name @smogon/calc can build. Cosmetic formes (Gastrodon-East) are not in
 * its dex; the base forme has the same battle stats. A forme the calc lists
 * (Ogerpon-Wellspring) is kept.
 */
export function speciesForCalc(species: string): string {
  const known = calcSpeciesCache.get(species);
  if (known) return known;
  const dex = Dex.species.get(species);
  const primary = dex.exists ? dex.name : species;
  const candidates = [primary];
  if (dex.baseSpecies && !candidates.includes(dex.baseSpecies)) candidates.push(dex.baseSpecies);
  let picked = primary;
  for (const name of candidates) {
    try {
      const mon = new CalcPokemon(9, name, { level: 80 });
      if (mon.species?.baseStats?.hp) {
        picked = name;
        break;
      }
    } catch {
      // Try the base forme.
    }
  }
  calcSpeciesCache.set(species, picked);
  return picked;
}

function calcMon(pokemon: any): CalcPokemon {
  const set = pokemon.set || {};
  const status = pokemon.status && pokemon.status !== '???' ? pokemon.status : undefined;
  // The sim stores ids ("levitate"). @smogon/calc only applies the display
  // name ("Levitate"). Passing the id overrides the species ability and
  // Ground moves hit Levitate targets.
  return new CalcPokemon(9, speciesForCalc(pokemon.species.name), {
    level: pokemon.level,
    ability: dexName('abilities', pokemon.ability || set.ability),
    item: dexName('items', pokemon.item || set.item),
    nature: dexName('natures', set.nature),
    evs: set.evs,
    ivs: set.ivs,
    boosts: {
      atk: pokemon.boosts?.atk || 0,
      def: pokemon.boosts?.def || 0,
      spa: pokemon.boosts?.spa || 0,
      spd: pokemon.boosts?.spd || 0,
      spe: pokemon.boosts?.spe || 0,
    },
    status,
    curHP: pokemon.hp,
  });
}

/**
 * Expected damage from @smogon/calc. Status and unknown moves deal 0.
 * This is the max-damage heuristic — no hand-rolled type chart.
 */
export function expectedDamage(attacker: any, defender: any, moveName: string, weatherId?: string): number {
  try {
    const move = new Move(9, moveName);
    if (move.category === 'Status' || !move.bp) return 0;
    const weather = weatherId ? WEATHER[weatherId] : undefined;
    const field = new Field(weather ? { weather } : {});
    const result = calculate(9, calcMon(attacker), calcMon(defender), move, field);
    if (!result.damage) return 0;
    const accuracy = Dex.moves.get(moveName).accuracy;
    const hitChance = accuracy === true || accuracy == null ? 1 : Number(accuracy) / 100;
    return averageDamage(result.damage as number | number[] | number[][]) * hitChance;
  } catch {
    return 0;
  }
}

/**
 * Highest-damage legal move. Forced switches use the first legal switch.
 * This is the frozen max-damage baseline.
 */
export function maxDamageChoice(battle: Battle, sideId: SideId, choices?: string[]): string {
  const legal = choices || legalChoices(battle, sideId);
  if (legal.length === 0) return 'default';
  const moves = legal.filter(choice => choice.startsWith('move '));
  if (moves.length === 0) return legal[0];

  const side = battle.getSide(sideId);
  const attacker = side.active[0];
  const defender = side.foe.active[0];
  if (!attacker || !defender) return moves[0];

  const weather = (battle.field as any).weather?.id as string | undefined;
  let best = moves[0];
  let bestDamage = -1;
  for (const choice of moves) {
    const index = moveSlotIndex(choice);
    const moveId = attacker.moveSlots[index]?.id;
    if (!moveId) continue;
    const damage = expectedDamage(attacker, defender, moveId, weather);
    if (damage > bestDamage) {
      bestDamage = damage;
      best = choice;
    }
  }
  return best;
}
