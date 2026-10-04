import type { Action, PokemonBelief } from '../types/index.js';
import type { AdvisorCandidate, CompactPokemon, CompactStateSummary } from './types.js';
import type { GameState } from '../types/index.js';

export function actionId(action: Action): string {
  if (action.type === 'move') {
    return action.terastallize ? `move:${action.moveIndex}:tera` : `move:${action.moveIndex}`;
  }
  return `switch:${action.switchIndex}`;
}

export function actionLabel(action: Action): string {
  if (action.type === 'move') {
    const tera = action.terastallize ? ' + terastallize' : '';
    return `move slot ${action.moveIndex}${tera}`;
  }
  return `switch to slot ${action.switchIndex}`;
}

export function summarizeState(state: GameState): CompactStateSummary {
  return {
    turn: state.turn,
    player: state.playerId ?? 'unknown',
    field: state.field,
    hazards: state.hazards,
    myActive: summarizeMon(state.myTeam[state.myActive]),
    opponentActive: summarizeMon(state.opponentTeam[state.opponentActive]),
    myBench: state.myTeam.filter((_, index) => index !== state.myActive).map(summarizeMon).filter(isMon),
    opponentBench: state.opponentTeam
      .filter((_, index) => index !== state.opponentActive)
      .map(summarizeMon)
      .filter(isMon),
    teraUsed: { mine: state.myTeraUsed, opponent: state.opponentTeraUsed },
  };
}

export function toAdvisorCandidates(
  scored: Array<{ action: Action; searchScore: number }>,
  topK: number
): AdvisorCandidate[] {
  return [...scored]
    .sort((a, b) => b.searchScore - a.searchScore)
    .slice(0, topK)
    .map((candidate, index) => ({
      id: `a${index}`,
      label: `${actionLabel(candidate.action)} [${actionId(candidate.action)}] search=${candidate.searchScore}`,
      action: candidate.action,
      searchScore: candidate.searchScore,
    }));
}

function summarizeMon(mon: PokemonBelief | undefined): CompactPokemon | null {
  if (!mon) return null;
  const hpPercent =
    mon.currentHp != null && mon.maxHp ? Math.round((mon.currentHp / mon.maxHp) * 1000) / 1000 : null;
  return {
    species: mon.species,
    hpPercent,
    status: mon.status,
    revealedMoves: [...mon.revealedMoves],
    ability: mon.revealedAbility,
    item: mon.revealedItem,
    teraType: mon.revealedTeraType,
  };
}

function isMon(mon: CompactPokemon | null): mon is CompactPokemon {
  return mon != null;
}
