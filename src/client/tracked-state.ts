import { Battle } from '@pkmn/client';
import { GameState, PokemonBelief } from '../types/index.js';
import { StateMismatch } from '../types/format.js';

/**
 * Species key used by buildGameState and reconcileState: the request ident
 * nickname (`p1: Squawkabilly`), falling back to the details species.
 * Details often carry a forme (`Squawkabilly-Blue`) that the ident omits.
 */
export function requestSpecies(mon: { ident?: string; details?: string; name?: string } | undefined): string {
  if (!mon) return 'Unknown';
  const fromIdent = mon.ident?.split(':')[1]?.trim().split(',')[0];
  if (fromIdent) return fromIdent;
  if (mon.name) return mon.name;
  const fromDetails = mon.details?.split(',')[0]?.trim();
  return fromDetails || 'Unknown';
}

function cloneBelief(mon: PokemonBelief): PokemonBelief {
  return {
    ...mon,
    possibleSets: new Map(mon.possibleSets),
    revealedMoves: new Set(mon.revealedMoves),
    moves: mon.moves ? [...mon.moves] : undefined,
    stats: mon.stats ? { ...mon.stats } : undefined,
    boosts: mon.boosts ? { ...mon.boosts } : undefined,
  };
}

export function cloneGameState(state: GameState): GameState {
  return {
    ...state,
    myTeam: state.myTeam.map(cloneBelief),
    opponentTeam: state.opponentTeam.map(cloneBelief),
    field: {
      ...state.field,
      screens: { ...state.field.screens },
    },
    hazards: {
      my: { ...state.hazards.my },
      opponent: { ...state.hazards.opponent },
    },
  };
}

/**
 * Overlay protocol HP / active slot onto the previous request snapshot.
 * Percentage HP from the stream is scaled onto the request's absolute max.
 */
export function overlayProtocol(
  snapshot: GameState,
  battle: Battle,
  ourSide: 'p1' | 'p2',
): GameState {
  const tracked = cloneGameState(snapshot);
  const side = ourSide === 'p1' ? battle.p1 : battle.p2;
  tracked.turn = battle.turn || tracked.turn;

  for (const mon of side.team) {
    const species = requestSpecies(mon);
    const idx = tracked.myTeam.findIndex(candidate => candidate.species === species);
    if (idx < 0) continue;
    const slot = tracked.myTeam[idx];
    const protocolMax = mon.maxhp || 0;
    const protocolHp = mon.hp || 0;
    if (protocolMax > 0 && slot.maxHp && slot.maxHp !== protocolMax && protocolMax === 100) {
      slot.currentHp = Math.round((slot.maxHp * protocolHp) / 100);
    } else if (protocolMax > 0) {
      slot.currentHp = protocolHp;
      slot.maxHp = protocolMax;
    }
    if (mon.fainted) slot.currentHp = 0;
    if (mon.status) slot.status = mon.status;
  }

  // A faint clears side.active and leaves the fainted Pokémon in lastPokemon.
  // The force-switch request still marks that Pokémon active.
  const active = side.active[0] ?? (side.lastPokemon?.fainted ? side.lastPokemon : null);
  if (active) {
    const species = requestSpecies(active);
    const idx = tracked.myTeam.findIndex(candidate => candidate.species === species);
    if (idx >= 0) tracked.myActive = idx;
  }

  return tracked;
}

/**
 * Put tracked slots in the request's party order so index-based
 * reconciliation compares the same Pokémon. Protocol HP stays attached
 * to the species it was observed on.
 */
export function alignToRequest(tracked: GameState, request: any): GameState {
  const pokemon = request?.side?.pokemon;
  if (!Array.isArray(pokemon) || pokemon.length === 0) return tracked;
  const aligned = cloneGameState(tracked);
  const bySpecies = new Map(aligned.myTeam.map(mon => [mon.species, mon]));
  const next: PokemonBelief[] = [];
  for (const mon of pokemon) {
    const species = requestSpecies(mon);
    const known = species ? bySpecies.get(species) : undefined;
    if (known) {
      next.push(known);
      bySpecies.delete(species);
    }
  }
  for (const leftover of bySpecies.values()) next.push(leftover);
  const activeSpecies = tracked.myTeam[tracked.myActive]?.species;
  aligned.myTeam = next;
  if (activeSpecies) {
    const idx = next.findIndex(mon => mon.species === activeSpecies);
    if (idx >= 0) aligned.myActive = idx;
  }
  return aligned;
}

export function mismatchData(mismatches: StateMismatch[]): Array<Record<string, unknown>> {
  return mismatches.map(mismatch => ({
    field: mismatch.field,
    tracked: mismatch.tracked,
    actual: mismatch.actual,
    severity: mismatch.severity,
  }));
}
