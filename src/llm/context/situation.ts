import { Dex } from '@pkmn/dex';
import type { BoardInput } from './types.js';
import type { Principle } from './meta.js';

export interface Situation {
  switching: boolean;
  threatened: boolean;
  early: boolean;
  late: boolean;
  canTera: boolean;
  foeTeraLeft: boolean;
  setupMove: boolean;
  foeBoosted: boolean;
  hazardMove: boolean;
  hazardsUp: boolean;
  statusMove: boolean;
  endgame: boolean;
  lowInfo: boolean;
  speedRelevant: boolean;
  pivotMove: boolean;
  foeAbilityUnknown: boolean;
  foeItemUnknown: boolean;
}

const HAZARD_IDS = new Set(['stealthrock', 'spikes', 'toxicspikes', 'stickyweb', 'ceaselessedge', 'stoneaxe']);
const PIVOT_IDS = new Set(['uturn', 'voltswitch', 'flipturn', 'partingshot', 'shedtail', 'teleport', 'chillyreception']);

export function deriveSituation(board: BoardInput): Situation {
  const names = legalMoveNames(board);
  const aliveMine = board.myTeam.filter(mon => !mon.fainted).length;
  const aliveFoe = board.opponentTeam.filter(mon => !mon.fainted).length;
  const foe = board.opponentTeam[board.opponentActive];
  const hazards = board.hazards;
  const hazardsUp =
    hazards.my.stealthRock ||
    hazards.opponent.stealthRock ||
    hazards.my.spikes > 0 ||
    hazards.opponent.spikes > 0 ||
    hazards.my.toxicSpikes > 0 ||
    hazards.opponent.toxicSpikes > 0;
  return {
    switching: board.legal.some(option => option.action.type === 'switch'),
    threatened: board.facts?.threatened ?? false,
    early: board.turn <= 3,
    late: board.turn > 15,
    canTera: board.canTera,
    foeTeraLeft: !board.opponentTeraUsed,
    setupMove: names.some(isSetup),
    foeBoosted: !!foe && Object.values(foe.boosts).some(stage => (stage ?? 0) > 0),
    hazardMove: names.some(isHazard),
    hazardsUp,
    statusMove: names.some(isStatus),
    endgame: (aliveMine > 0 && aliveMine <= 3 && aliveFoe > 0 && aliveFoe <= 3) || board.turn >= 20,
    lowInfo: board.turn <= 5 || board.opponentTeam.filter(mon => mon.seen && !mon.fainted).length <= 2,
    speedRelevant: !!board.myTeam[board.myActive] && !!foe && !foe.fainted,
    pivotMove: names.some(isPivot),
    foeAbilityUnknown: !!foe && !foe.abilityKnown,
    foeItemUnknown: !!foe && !foe.itemKnown,
  };
}

export function topicWeight(topic: string, situation: Situation): number {
  switch (topic) {
    case 'switching':
      return (situation.switching ? 2 : 0) + (situation.threatened ? 2 : 0);
    case 'prediction':
      return situation.threatened || situation.early ? 3 : situation.switching ? 1 : 0;
    case 'tera':
      return situation.canTera ? 4 : situation.foeTeraLeft ? 1 : 0;
    case 'wincon':
      return 1 + (situation.early ? 1 : 0);
    case 'setup':
      return situation.setupMove || situation.foeBoosted ? 3 : 0;
    case 'hazards':
      return situation.hazardMove || situation.hazardsUp ? 3 : 0;
    case 'speed':
      return situation.speedRelevant ? 2 : 0;
    case 'inference':
      return situation.lowInfo ? 2 : 1;
    case 'items':
      return situation.foeItemUnknown ? 1 : 0;
    case 'abilities':
      return situation.foeAbilityUnknown ? 1 : 0;
    case 'status':
      return situation.statusMove ? 2 : 0;
    case 'endgame':
      return situation.endgame ? 4 : 0;
    case 'information':
      return situation.lowInfo ? 2 : 0;
    case 'levels':
      return situation.lowInfo ? 1 : 0;
    case 'mistakes':
      return situation.switching ? 2 : 1;
    default:
      return 0;
  }
}

const CONFIDENCE: Record<string, number> = { high: 2, medium: 1, low: 0 };

export function selectPrinciples(principles: Principle[], situation: Situation, maxChars: number): Principle[] {
  const ranked = principles
    .map(principle => ({ principle, weight: topicWeight(principle.topic, situation) }))
    .filter(row => row.weight > 0)
    .sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      const confidence = (CONFIDENCE[b.principle.confidence] ?? 0) - (CONFIDENCE[a.principle.confidence] ?? 0);
      if (confidence !== 0) return confidence;
      return a.principle.id < b.principle.id ? -1 : 1;
    });

  const picked: Principle[] = [];
  let used = 0;
  for (const row of ranked) {
    const line = formatPrinciple(row.principle);
    const next = used + line.length + 1;
    if (picked.length > 0 && next > maxChars) break;
    if (picked.length === 0 && line.length > maxChars) {
      picked.push(row.principle);
      break;
    }
    picked.push(row.principle);
    used = next;
  }
  return picked;
}

export function formatPrinciple(principle: Principle): string {
  return `${principle.id} (${principle.confidence}): ${principle.principle}`;
}

function legalMoveNames(board: BoardInput): string[] {
  const actor = board.myTeam[board.myActive];
  if (!actor) return [];
  const names: string[] = [];
  for (const option of board.legal) {
    if (option.action.type !== 'move') continue;
    const name = actor.moveSlots[option.action.moveIndex - 1];
    if (name) names.push(name);
  }
  return names;
}

function moveId(name: string): string {
  return Dex.moves.get(name).id;
}

function isSetup(name: string): boolean {
  const move = Dex.moves.get(name);
  return !!move.boosts && (move.target === 'self' || move.target === 'allies');
}

function isHazard(name: string): boolean {
  return HAZARD_IDS.has(moveId(name));
}

function isPivot(name: string): boolean {
  return PIVOT_IDS.has(moveId(name));
}

function isStatus(name: string): boolean {
  const move = Dex.moves.get(name);
  return move.category === 'Status' && !isSetup(name) && !isHazard(name) && !isPivot(name);
}
