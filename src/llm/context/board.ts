import { Dex } from '@pkmn/dex';
import type { Battle } from '@pkmn/sim';
import type { Action, GameState, PokemonBelief, RandbatsStats } from '../../types/index.js';
import type { SideId } from '../../engine/exact/battle-utils.js';
import { legalChoices } from '../../engine/exact/battle-utils.js';
import { readLog, emptyLog } from './log.js';
import type { BoardInput, BoardMon, LegalOption, StatSpread } from './types.js';

const BOOSTS = ['atk', 'def', 'spa', 'spd', 'spe'] as const;

export function withTeraChoices(battle: Battle, side: SideId): string[] {
  const base = legalChoices(battle, side);
  const request = battle.getSide(side).activeRequest as { active?: Array<{ canTerastallize?: unknown }>; forceSwitch?: unknown } | null;
  if (!request || request.forceSwitch || !request.active?.[0]?.canTerastallize) return base;
  const choices: string[] = [];
  for (const choice of base) {
    choices.push(choice);
    if (/^move \d+$/.test(choice)) choices.push(`${choice} terastallize`);
  }
  return choices;
}

export function boardFromSim(battle: Battle, side: SideId, pools: RandbatsStats): BoardInput {
  const me = battle.getSide(side);
  const foe = me.foe;
  const foeSide: SideId = side === 'p1' ? 'p2' : 'p1';
  const logLines = (battle.log as string[] | undefined) ?? [];
  const reveals = revealsFromLog(logLines);
  const myTeam = me.pokemon.map((pokemon, index) => simMon(pokemon, index + 1, true, reveals, side));
  const opponentTeam = foe.pokemon
    .map((pokemon, index) => ({ pokemon, index }))
    .filter(row => (row.pokemon as { previouslySwitchedIn?: number }).previouslySwitchedIn)
    .map(row => simMon(row.pokemon, row.index + 1, false, reveals, foeSide));
  const myActive = Math.max(0, me.pokemon.findIndex(pokemon => pokemon.isActive));
  const opponentActive = Math.max(0, opponentTeam.findIndex(mon => mon.active));
  const request = me.activeRequest as { active?: Array<{ canTerastallize?: unknown }>; forceSwitch?: unknown } | null;
  const choices = withTeraChoices(battle, side);
  return {
    turn: battle.turn,
    player: side,
    foeSide,
    myTeam,
    opponentTeam,
    myActive,
    opponentActive: opponentTeam.length === 0 ? 0 : opponentActive,
    field: fieldFromSim(battle),
    hazards: {
      my: hazardsFromSide(me),
      opponent: hazardsFromSide(foe),
    },
    myTeraUsed: me.pokemon.some(pokemon => !!(pokemon as { terastallized?: string }).terastallized),
    opponentTeraUsed: foe.pokemon.some(pokemon => !!(pokemon as { terastallized?: string }).terastallized),
    canTera: !request?.forceSwitch && !!request?.active?.[0]?.canTerastallize,
    log: readLog(logLines, foeSide),
    legal: choices.map((choice, index) => legalFromChoice(choice, index, myTeam)),
    pools,
  };
}

export function boardFromGameState(state: GameState, legal: Action[], pools: RandbatsStats): BoardInput {
  const foeSide = state.playerId === 'p2' ? 'p1' : 'p2';
  const myTeam = state.myTeam.map((mon, index) => beliefMon(mon, index + 1, index === state.myActive, true));
  const opponentTeam = state.opponentTeam
    .filter(mon => mon.species && mon.species !== 'Unknown')
    .map((mon, index) => beliefMon(mon, index + 1, index === state.opponentActive, false));
  return {
    turn: state.turn,
    player: state.playerId ?? 'unknown',
    foeSide,
    myTeam,
    opponentTeam,
    myActive: state.myActive,
    opponentActive: state.opponentActive,
    field: state.field,
    hazards: state.hazards,
    myTeraUsed: state.myTeraUsed,
    opponentTeraUsed: state.opponentTeraUsed,
    canTera: legal.some(action => action.type === 'move' && action.terastallize),
    log: state.recentLines ? readLog(state.recentLines, foeSide) : emptyLog(),
    legal: legal.map((action, index) => legalFromAction(action, index, myTeam, state)),
    pools,
  };
}

function simMon(
  pokemon: Battle['p1']['pokemon'][number],
  slot: number,
  ours: boolean,
  reveals: RevealIndex,
  side: SideId
): BoardMon {
  const species = pokemon.species?.name || 'Unknown';
  const key = `${side}:${species}`;
  const set = (pokemon as { set?: { ability?: string; item?: string; nature?: string; evs?: StatSpread; teraType?: string } }).set;
  const terastallized = (pokemon as { terastallized?: string }).terastallized || undefined;
  const known = reveals.get(key) ?? { moves: [], ability: undefined, item: undefined, tera: undefined };
  const moveSlots = ours
    ? pokemon.moveSlots.map(move => Dex.moves.get(move.id).name).filter(name => name && name !== '')
    : [];
  const abilityKnown = ours || !!known.ability;
  const itemKnown = ours || !!known.item;
  const teraKnown = ours || !!terastallized || !!known.tera;
  return {
    species,
    slot,
    active: !!pokemon.isActive,
    fainted: !!pokemon.fainted || pokemon.hp <= 0,
    seen: ours ? !!(pokemon as { previouslySwitchedIn?: number }).previouslySwitchedIn : true,
    level: pokemon.level,
    hpPercent: pokemon.maxhp > 0 ? Math.round((Math.max(0, pokemon.hp) / pokemon.maxhp) * 1000) / 10 : null,
    status: pokemon.status || undefined,
    boosts: boostsFrom(pokemon.boosts),
    types: speciesTypes(species),
    knownMoves: ours ? moveSlots : known.moves,
    moveSlots,
    ability: ours ? display(set?.ability || pokemon.ability) : known.ability,
    abilityKnown,
    item: ours ? display(set?.item || pokemon.item) : known.item,
    itemKnown,
    teraType: ours ? display(set?.teraType || (pokemon as { teraType?: string }).teraType) : terastallized || known.tera,
    teraKnown,
    terastallized: terastallized || known.tera,
    nature: ours ? display(set?.nature) || 'Serious' : undefined,
    evs: ours ? set?.evs ?? { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 } : undefined,
  };
}

function beliefMon(mon: PokemonBelief, slot: number, active: boolean, ours: boolean): BoardMon {
  const moveSlots = ours && mon.moves?.length ? mon.moves.map(move => Dex.moves.get(move).name) : [];
  const knownMoves = moveSlots.length > 0 ? moveSlots : [...(mon.revealedMoves ?? [])].map(move => Dex.moves.get(move).name);
  const hpPercent = mon.currentHp != null && mon.maxHp ? Math.round((mon.currentHp / mon.maxHp) * 1000) / 10 : null;
  return {
    species: mon.species,
    slot,
    active,
    fainted: mon.currentHp === 0,
    seen: true,
    level: mon.level,
    hpPercent,
    status: mon.status,
    boosts: {
      atk: mon.boosts?.atk || undefined,
      def: mon.boosts?.def || undefined,
      spa: mon.boosts?.spa || undefined,
      spd: mon.boosts?.spd || undefined,
      spe: mon.boosts?.spe || undefined,
    },
    types: speciesTypes(mon.species),
    knownMoves,
    moveSlots,
    ability: mon.revealedAbility,
    abilityKnown: !!mon.revealedAbility,
    item: mon.revealedItem,
    itemKnown: !!mon.revealedItem,
    teraType: mon.revealedTeraType,
    teraKnown: !!mon.revealedTeraType,
    terastallized: mon.revealedTeraType,
    nature: ours ? 'Serious' : undefined,
    evs: ours ? { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 } : undefined,
  };
}

interface RevealBucket {
  moves: string[];
  ability?: string;
  item?: string;
  tera?: string;
}

type RevealIndex = Map<string, RevealBucket>;

function revealsFromLog(lines: readonly string[]): RevealIndex {
  const index: RevealIndex = new Map();
  const bucket = (key: string): RevealBucket => {
    let row = index.get(key);
    if (!row) {
      row = { moves: [] };
      index.set(key, row);
    }
    return row;
  };
  for (const line of lines) {
    const who = line.match(/^\|[^|]+\|(p[12])a: [^|]*\|/);
    if (!who) continue;
    const side = who[1] as SideId;
    const species = speciesNear(line);
    if (!species) continue;
    const key = `${side}:${species}`;
    const row = bucket(key);
    if (line.startsWith('|move|')) {
      const move = line.split('|')[3];
      if (move && move !== 'Recharge' && !row.moves.includes(move)) row.moves.push(move);
    } else if (line.startsWith('|-ability|')) {
      row.ability = line.split('|')[3];
    } else if (line.startsWith('|-item|') || line.startsWith('|-enditem|')) {
      row.item = line.split('|')[3];
    } else if (line.startsWith('|-terastallize|')) {
      row.tera = line.split('|')[3];
    }
  }
  return index;
}

function speciesNear(line: string): string | null {
  const parts = line.split('|');
  const details = parts[3];
  if (details && !details.startsWith('p') && line.startsWith('|switch|')) return details.split(',')[0];
  const named = parts[2]?.split(':')[1]?.trim();
  return named || null;
}

function fieldFromSim(battle: Battle): GameState['field'] {
  const field = battle.field as {
    weather?: string | { id?: string };
    terrain?: string | { id?: string };
    pseudoWeather?: Record<string, unknown>;
  };
  const weather = typeof field.weather === 'string' ? field.weather : field.weather?.id;
  const terrain = typeof field.terrain === 'string' ? field.terrain : field.terrain?.id;
  return {
    weather: weather || undefined,
    terrain: terrain || undefined,
    trickRoom: !!field.pseudoWeather?.trickroom,
    screens: {},
  };
}

function hazardsFromSide(side: Battle['p1']): GameState['hazards']['my'] {
  const conditions = side.sideConditions as Record<string, { layers?: number } | undefined>;
  return {
    stealthRock: !!conditions.stealthrock,
    spikes: conditions.spikes?.layers ?? 0,
    toxicSpikes: conditions.toxicspikes?.layers ?? 0,
  };
}

function legalFromChoice(choice: string, index: number, myTeam: BoardMon[]): LegalOption {
  return {
    id: `a${index}`,
    choice,
    action: choiceToAction(choice),
    label: choiceLabel(choice, myTeam),
  };
}

function legalFromAction(action: Action, index: number, myTeam: BoardMon[], state: GameState): LegalOption {
  const choice = action.type === 'switch'
    ? `switch ${action.switchIndex}`
    : action.terastallize
      ? `move ${action.moveIndex} terastallize`
      : `move ${action.moveIndex}`;
  const actor = state.myTeam[state.myActive];
  const moveName = action.type === 'move' ? actor?.moves?.[action.moveIndex - 1] : undefined;
  const label = action.type === 'switch'
    ? `switch ${state.myTeam[action.switchIndex - 1]?.species ?? `slot ${action.switchIndex}`}`
    : `${moveName ?? `move ${action.moveIndex}`}${action.terastallize ? ' + tera' : ''}`;
  return { id: `a${index}`, choice, action, label: label || choiceLabel(choice, myTeam) };
}

export function choiceToAction(choice: string): Action {
  if (choice.startsWith('switch')) {
    const slot = Number(choice.slice(7));
    return { type: 'switch', switchIndex: Number.isFinite(slot) ? slot : 1 };
  }
  const slot = Number(choice.split(' ')[1]);
  const action: Action = { type: 'move', moveIndex: Number.isFinite(slot) ? slot : 1 };
  if (choice.includes('terastallize')) action.terastallize = true;
  return action;
}

function choiceLabel(choice: string, myTeam: BoardMon[]): string {
  if (choice.startsWith('switch')) {
    const slot = Number(choice.slice(7));
    const mon = myTeam.find(candidate => candidate.slot === slot);
    return `switch ${mon?.species ?? `slot ${slot}`}`;
  }
  const actor = myTeam.find(mon => mon.active) ?? myTeam[0];
  const index = Number(choice.split(' ')[1]) - 1;
  const name = actor?.moveSlots[index] ?? `move ${index + 1}`;
  return choice.includes('terastallize') ? `${name} + tera` : name;
}

function speciesTypes(species: string): string[] {
  const data = Dex.species.get(species);
  return data.exists ? [...data.types] : [];
}

function boostsFrom(boosts: { atk?: number; def?: number; spa?: number; spd?: number; spe?: number } | undefined): BoardMon['boosts'] {
  const out: BoardMon['boosts'] = {};
  if (!boosts) return out;
  for (const stat of BOOSTS) {
    if (boosts[stat]) out[stat] = boosts[stat];
  }
  return out;
}

function display(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ability = Dex.abilities.get(value);
  if (ability.exists) return ability.name;
  const item = Dex.items.get(value);
  if (item.exists) return item.name;
  const type = Dex.types.get(value);
  if (type.exists) return type.name;
  return value;
}
