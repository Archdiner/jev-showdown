import { Battle as ClientBattle, Pokemon as ClientPokemon } from '@pkmn/client';
import { FoeMon, LivePosition, StatBoosts } from './decision-battle.js';

export type ViewerSide = 'p1' | 'p2';

function boostsOf(mon: ClientPokemon): StatBoosts {
  return {
    atk: mon.boosts?.atk || 0,
    def: mon.boosts?.def || 0,
    spa: mon.boosts?.spa || 0,
    spd: mon.boosts?.spd || 0,
    spe: mon.boosts?.spe || 0,
  };
}

function snap(mon: ClientPokemon): FoeMon | null {
  const species = mon.speciesForme || '';
  if (!species) return null;
  return {
    species,
    level: mon.level || 80,
    hp: mon.hp,
    maxhp: mon.maxhp || 100,
    status: mon.status,
    ability: mon.ability || undefined,
    item: mon.item || undefined,
    moves: [...(mon.moves || [])],
    boosts: boostsOf(mon),
    fainted: mon.fainted || mon.hp <= 0,
    itemUnknown: !mon.item && !mon.lastItem && !mon.itemEffect,
    abilityUnknown: !mon.ability,
  };
}

/**
 * The ladder's decision input. `battle` is the `@pkmn/client` battle that has
 * consumed the public protocol. `request` is this side's private request.
 * BattleDriver.livePosition is this function.
 */
export function livePositionFromClient(
  battle: ClientBattle,
  request: unknown,
  ourSide: ViewerSide,
): LivePosition {
  const foeSide = ourSide === 'p2' ? battle.p1 : battle.p2;
  const ours = ourSide === 'p2' ? battle.p2 : battle.p1;
  const active = foeSide?.active?.[0] ?? null;
  const foeActive = active ? snap(active) : null;
  const foeBench = (foeSide?.team || [])
    .filter(mon => mon && mon !== active)
    .map(mon => snap(mon))
    .filter((mon): mon is FoeMon => !!mon);
  const weather = battle.currentWeather();
  return {
    request,
    foeActive,
    foeBench,
    ourBoosts: ours?.active?.[0] ? boostsOf(ours.active[0]) : undefined,
    weather: weather ? String(weather) : undefined,
  };
}
