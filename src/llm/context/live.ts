import type { Battle, Pokemon, Side } from '@pkmn/client';
import type { ID } from '@pkmn/data';
import type { GameState, PokemonBelief } from '../../types/index.js';

/** Overlay public client-battle facts onto a request snapshot. Does not invent unrevealed foe mons. */
export function applyClientBattle(state: GameState, battle: Battle, ourSide: 'p1' | 'p2'): void {
  const us = ourSide === 'p1' ? battle.p1 : battle.p2;
  const foe = us.foe;
  state.field = {
    weather: battle.field.weather,
    terrain: battle.field.terrain,
    trickRoom: battle.field.hasPseudoWeather('trickroom' as ID),
    screens: {
      reflect: conditionLevel(us, 'reflect'),
      lightScreen: conditionLevel(us, 'lightscreen'),
    },
  };
  state.hazards = {
    my: hazards(us),
    opponent: hazards(foe),
  };
  state.myTeraUsed = us.team.some(mon => !!mon.terastallized);
  state.opponentTeraUsed = foe.team.some(mon => !!mon.terastallized);

  for (const mon of us.team) {
    const slot = state.myTeam.find(candidate => candidate.species === mon.speciesForme || candidate.species === mon.name);
    if (!slot) continue;
    overlay(slot, mon, true);
  }

  const seen = foe.team.filter(mon => mon.speciesForme && mon.speciesForme !== 'Unknown');
  if (seen.length === 0) return;
  state.opponentTeam = seen.map(mon => {
    const belief = blank(mon.speciesForme || mon.name, mon.level);
    overlay(belief, mon, false);
    return belief;
  });
  const active = foe.active[0] ?? (foe.lastPokemon?.fainted ? foe.lastPokemon : null);
  const activeIndex = active ? state.opponentTeam.findIndex(mon => mon.species === (active.speciesForme || active.name)) : 0;
  state.opponentActive = activeIndex >= 0 ? activeIndex : 0;
}

function overlay(slot: PokemonBelief, mon: Pokemon, ours: boolean): void {
  if (mon.maxhp > 0) {
    slot.maxHp = mon.maxhp;
    slot.currentHp = mon.fainted ? 0 : mon.hp;
  }
  if (mon.status) slot.status = mon.status;
  slot.boosts = {
    atk: mon.boosts.atk || 0,
    def: mon.boosts.def || 0,
    spa: mon.boosts.spa || 0,
    spd: mon.boosts.spd || 0,
    spe: mon.boosts.spe || 0,
    accuracy: mon.boosts.accuracy || 0,
    evasion: mon.boosts.evasion || 0,
  };
  const moves = mon.moveSlots.map(move => (move?.name ? String(move.name) : '')).filter(name => name.length > 0);
  if (ours && slot.moves && slot.moves.length > 0) {
    slot.revealedMoves = new Set(slot.moves);
  } else if (moves.length > 0) {
    slot.revealedMoves = new Set(moves);
    if (ours) slot.moves = moves;
  }
  if (ours || mon.ability) slot.revealedAbility = ours ? slot.revealedAbility || mon.ability || undefined : mon.ability || undefined;
  if (ours && mon.item) slot.revealedItem = slot.revealedItem || mon.item;
  else if (mon.itemEffect || mon.lastItem) slot.revealedItem = mon.item || mon.lastItem || undefined;
  if (mon.terastallized) slot.revealedTeraType = mon.terastallized;
  else if (ours && mon.teraType) slot.revealedTeraType = mon.teraType;
}

function blank(species: string, level: number): PokemonBelief {
  return { species, level: level || 80, possibleSets: new Map(), revealedMoves: new Set() };
}

function hazards(side: Side): GameState['hazards']['my'] {
  return {
    stealthRock: !!side.sideConditions.stealthrock,
    spikes: conditionLevel(side, 'spikes'),
    toxicSpikes: conditionLevel(side, 'toxicspikes'),
  };
}

function conditionLevel(side: Side, id: string): number {
  const condition = side.sideConditions[id];
  if (!condition) return 0;
  return condition.level || 1;
}
