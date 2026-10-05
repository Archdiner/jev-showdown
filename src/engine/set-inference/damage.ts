import { Dex } from '@pkmn/sim';
import { calculate, Field, Move, Pokemon } from '@smogon/calc';
import type { StatBlock } from './catalog.js';

export interface DamageQuery {
  attackerSpecies: string;
  attackerLevel: number;
  attackerAbility?: string;
  attackerItem?: string;
  attackerEvs?: StatBlock;
  attackerIvs?: StatBlock;
  attackerBoosts?: Partial<StatBlock>;
  defenderSpecies: string;
  defenderLevel: number;
  defenderAbility?: string;
  defenderItem?: string;
  defenderEvs?: StatBlock;
  defenderIvs?: StatBlock;
  defenderBoosts?: Partial<StatBlock>;
  defenderStatus?: string;
  move: string;
  /** HP lost by the defender. */
  observed: number;
  tolerance: number;
  weather?: 'Sun' | 'Rain' | 'Sand' | 'Snow';
}

const DEFAULT_EVS: StatBlock = { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 };
const DEFAULT_IVS: StatBlock = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };

/**
 * P(observed damage | item) for each candidate item on `which` side.
 * Returns null when the roll ranges do not separate the items, so a
 * non-informative calc does not move the posterior.
 */
export function informativeItemLikelihood(
  query: Omit<DamageQuery, 'attackerItem' | 'defenderItem'> & { candidates: string[] },
  which: 'attacker' | 'defender',
  knownItem?: string,
): Map<string, number> | null {
  const move = Dex.moves.get(query.move);
  if (!move.exists || move.category === 'Status' || move.ohko || typeof move.damage === 'number') return null;
  const out = new Map<string, number>();
  for (const item of query.candidates) {
    const rolls = rollsFor({
      ...query,
      attackerItem: which === 'attacker' ? item : knownItem,
      defenderItem: which === 'defender' ? item : knownItem,
    });
    out.set(item, matchRolls(rolls, query.observed, query.tolerance));
  }
  const values = [...out.values()];
  if (values.length < 2) return null;
  const hi = Math.max(...values);
  const lo = Math.min(...values);
  if (lo <= 0 || hi / lo < 1.25) return null;
  return out;
}

export function rollsFor(query: DamageQuery): number[] {
  try {
    const field = new Field(query.weather ? { weather: query.weather } : {});
    const result = calculate(
      9,
      calcMon(query.attackerSpecies, query.attackerLevel, query.attackerAbility, query.attackerItem, query.attackerEvs, query.attackerIvs, query.attackerBoosts),
      calcMon(query.defenderSpecies, query.defenderLevel, query.defenderAbility, query.defenderItem, query.defenderEvs, query.defenderIvs, query.defenderBoosts, query.defenderStatus),
      new Move(9, query.move),
      field,
    );
    return flatten(result.damage);
  } catch {
    return [];
  }
}

function calcMon(
  species: string,
  level: number,
  ability: string | undefined,
  item: string | undefined,
  evs: StatBlock | undefined,
  ivs: StatBlock | undefined,
  boosts: Partial<StatBlock> | undefined,
  status?: string,
): Pokemon {
  return new Pokemon(9, species, {
    level,
    ability: ability || undefined,
    item: item || undefined,
    nature: 'Serious',
    evs: evs || DEFAULT_EVS,
    ivs: ivs || DEFAULT_IVS,
    boosts: {
      atk: boosts?.atk || 0,
      def: boosts?.def || 0,
      spa: boosts?.spa || 0,
      spd: boosts?.spd || 0,
      spe: boosts?.spe || 0,
    },
    status: status && status !== '???' ? status as 'brn' : undefined,
  });
}

function flatten(damage: unknown): number[] {
  if (typeof damage === 'number') return [damage];
  if (!Array.isArray(damage)) return [];
  const flat = damage.flat(2) as unknown[];
  return flat.filter((value): value is number => typeof value === 'number');
}

export function matchRolls(rolls: number[], observed: number, tolerance: number): number {
  if (!rolls.length || observed <= 0) return 1;
  const hits = rolls.filter(roll => Math.abs(roll - observed) <= tolerance).length;
  return Math.max(hits / rolls.length, 0.02);
}

export function weatherName(raw: string | undefined): 'Sun' | 'Rain' | 'Sand' | 'Snow' | undefined {
  const id = (raw || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (id === 'sunnyday' || id === 'sun' || id === 'desolateland') return 'Sun';
  if (id === 'raindance' || id === 'rain' || id === 'primordialsea') return 'Rain';
  if (id === 'sandstorm' || id === 'sand') return 'Sand';
  if (id === 'snow' || id === 'hail' || id === 'snowscape') return 'Snow';
  return undefined;
}
