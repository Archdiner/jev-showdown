import { Battle } from '@pkmn/client';
import { GameState, PokemonBelief } from '../types/index.js';
import { StateMismatch } from '../types/format.js';

function speciesFromDetails(details: string | undefined): string {
  if (!details) return 'Unknown';
  return details.split(',')[0]?.trim() || 'Unknown';
}

function cloneBelief(mon: PokemonBelief): PokemonBelief {
  return {
    ...mon,
    possibleSets: new Map(mon.possibleSets),
    revealedMoves: new Set(mon.revealedMoves),
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
    const species = speciesFromDetails(mon.details);
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

  const active = side.active[0];
  if (active) {
    const species = speciesFromDetails(active.details);
    const idx = tracked.myTeam.findIndex(candidate => candidate.species === species);
    if (idx >= 0) tracked.myActive = idx;
  }

  return tracked;
}

export function mismatchData(mismatches: StateMismatch[]): Array<Record<string, unknown>> {
  return mismatches.map(mismatch => ({
    field: mismatch.field,
    tracked: mismatch.tracked,
    actual: mismatch.actual,
    severity: mismatch.severity,
  }));
}
