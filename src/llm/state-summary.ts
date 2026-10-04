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

/** Jev's state budget is 32k tokens. Estimate four characters per token. */
export const MAX_EVALUATION_STATE_TOKENS = 32_000;
const CHARS_PER_TOKEN = 4;

export function capEvaluationState(text: string): string {
  const maxChars = MAX_EVALUATION_STATE_TOKENS * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

export function evaluationStateText(summary: CompactStateSummary, candidates: AdvisorCandidate[]): string {
  const mon = (label: string, pokemon: CompactPokemon | null): string => {
    if (!pokemon) return `${label}: none`;
    const moves = pokemon.revealedMoves.length > 0 ? pokemon.revealedMoves.join('/') : 'unknown';
    return `${label}: ${pokemon.species} hp=${pokemon.hpPercent ?? '?'} status=${pokemon.status ?? 'none'} moves=${moves}`;
  };
  const lines = [
    'Gen 9 Random Battle.',
    `turn=${summary.turn} player=${summary.player}`,
    mon('my active', summary.myActive),
    mon('opponent active', summary.opponentActive),
    `my bench: ${summary.myBench.map(pokemon => pokemon.species).join(', ') || 'none'}`,
    `opponent bench: ${summary.opponentBench.map(pokemon => pokemon.species).join(', ') || 'none'}`,
    `field weather=${summary.field.weather ?? 'none'} terrain=${summary.field.terrain ?? 'none'} trickRoom=${summary.field.trickRoom}`,
    `hazards mine rocks=${summary.hazards.my.stealthRock} spikes=${summary.hazards.my.spikes} toxicSpikes=${summary.hazards.my.toxicSpikes}`,
    `hazards opponent rocks=${summary.hazards.opponent.stealthRock} spikes=${summary.hazards.opponent.spikes} toxicSpikes=${summary.hazards.opponent.toxicSpikes}`,
    `tera used mine=${summary.teraUsed.mine} opponent=${summary.teraUsed.opponent}`,
    'candidate actions:',
    ...candidates.map(candidate => `${candidate.id} search=${candidate.searchScore} ${candidate.label}`),
  ];
  return capEvaluationState(lines.join('\n'));
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
