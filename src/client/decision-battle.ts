import { Battle, Dex, PRNG, PokemonSet } from '@pkmn/sim';
import { Action } from '../types/index.js';
import { decide } from '../engine/exact/policies.js';
import { legalChoices } from '../engine/exact/battle-utils.js';
import { EngineName } from './engines.js';
import { sameAction } from './choice.js';
import { ladderPolicy } from './ladder-engine.js';

export interface StatBoosts {
  atk?: number;
  def?: number;
  spa?: number;
  spd?: number;
  spe?: number;
}

/** One revealed pokemon, ours or the foe's. HP may be exact or a percent. */
export interface FoeMon {
  species: string;
  level: number;
  hp: number;
  maxhp: number;
  status?: string;
  ability?: string;
  item?: string;
  moves: string[];
  boosts?: StatBoosts;
  fainted?: boolean;
}

/**
 * What the ladder knows at a decision: the server request (move indices) and
 * the foe as the protocol client has seen them.
 */
export interface LivePosition {
  request: any;
  foeActive: FoeMon | null;
  foeBench: FoeMon[];
  ourBoosts?: StatBoosts;
  weather?: string;
}

const WEATHER: Record<string, string> = {
  rain: 'raindance',
  raindance: 'raindance',
  sun: 'sunnyday',
  sunnyday: 'sunnyday',
  sand: 'sandstorm',
  sandstorm: 'sandstorm',
  snow: 'snow',
  hail: 'snow',
  snowscape: 'snow',
};

const STATS = ['atk', 'def', 'spa', 'spd', 'spe'] as const;

export function actionFromChoice(choice: string): Action | null {
  const move = /^move (\d+)/.exec(choice);
  if (move) {
    const action: Action = { type: 'move', moveIndex: Number(move[1]) };
    if (choice.includes('terastallize')) action.terastallize = true;
    return action;
  }
  const swapped = /^switch (\d+)/.exec(choice);
  if (swapped) return { type: 'switch', switchIndex: Number(swapped[1]) };
  return null;
}

function speciesOf(details: string | undefined, ident: string | undefined): string {
  const fromDetails = details?.split(',')[0]?.trim();
  if (fromDetails) return fromDetails;
  return ident?.split(':').slice(1).join(':').trim() || '';
}

function levelOf(details: string | undefined, fallback: number): number {
  const match = details?.match(/L(\d+)/);
  return match ? Number(match[1]) : fallback;
}

function named(kind: 'abilities' | 'items' | 'moves' | 'species', raw: string | undefined): string {
  if (!raw) return '';
  const entry = Dex[kind].get(raw);
  return entry?.exists ? entry.name : '';
}

function toSet(
  species: string,
  moves: string[],
  level: number,
  ability?: string,
  item?: string,
  teraType?: string,
): PokemonSet | null {
  const speciesName = named('species', species);
  if (!speciesName) return null;
  const moveNames = moves.map(move => named('moves', move)).filter(Boolean).slice(0, 4);
  if (moveNames.length === 0) moveNames.push('Tackle');
  const dexSpecies = Dex.species.get(speciesName);
  const set: PokemonSet = {
    species: speciesName,
    moves: moveNames,
    ability: named('abilities', ability) || dexSpecies.abilities?.['0'] || 'Pressure',
    item: named('items', item) || '',
    nature: 'Hardy',
    evs: { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 },
    level: level || 80,
  } as PokemonSet;
  const teraName = teraType ? Dex.types.get(teraType).name : '';
  if (teraName && Dex.types.get(teraName).exists) set.teraType = teraName;
  return set;
}

function isForceSwitch(request: any): boolean {
  if (Array.isArray(request?.forceSwitch)) return request.forceSwitch.some(Boolean);
  return !!request?.forceSwitch;
}

function applyFraction(mon: any, hp: number, maxhp: number, fainted: boolean): void {
  if (fainted || hp <= 0) {
    mon.hp = 0;
    mon.fainted = true;
    return;
  }
  if (maxhp > 0 && mon.maxhp > 0) {
    mon.hp = Math.max(1, Math.round(mon.maxhp * (hp / maxhp)));
  }
}

function applyStatus(mon: any, condition: string | undefined, status: string | undefined): void {
  const fromCondition = condition?.match(/\b(par|brn|psn|tox|slp|frz)\b/);
  const name = status || fromCondition?.[1];
  if (!name || mon.fainted) return;
  try {
    mon.setStatus(name);
  } catch {
    mon.status = name;
  }
}

function applyBoosts(mon: any, boosts: StatBoosts | undefined): void {
  if (!mon || !boosts) return;
  for (const stat of STATS) {
    if (typeof boosts[stat] === 'number') mon.boosts[stat] = boosts[stat];
  }
}

function ourSets(request: any, quickWins: boolean): PokemonSet[] | null {
  const slots: any[] = request?.side?.pokemon || [];
  if (slots.length === 0) return null;
  const activeMoves: any[] = request?.active?.[0]?.moves || [];
  const sets: PokemonSet[] = [];
  for (let i = 0; i < slots.length && sets.length < 6; i++) {
    const slot = slots[i];
    const fromActive = i === 0 && activeMoves.length
      ? activeMoves.map((move: any) => move.id || move.move)
      : [];
    const moves = fromActive.length ? fromActive : (slot.moves || []);
    const rawTera = quickWins
      ? slot.teraType || (i === 0 ? request?.active?.[0]?.canTerastallize : undefined)
      : undefined;
    const set = toSet(
      speciesOf(slot.details, slot.ident),
      moves,
      levelOf(slot.details, slot.level || 80),
      slot.ability || slot.baseAbility,
      slot.item,
      typeof rawTera === 'string' ? rawTera : undefined,
    );
    // Dropping a slot would renumber `switch N`. Fail the build instead.
    if (!set) return null;
    sets.push(set);
  }
  return sets;
}

function knownFoes(position: LivePosition): FoeMon[] {
  return [position.foeActive, ...position.foeBench].filter((mon): mon is FoeMon => !!mon?.species);
}

function foeSets(foes: FoeMon[]): { sets: PokemonSet[]; kept: FoeMon[] } {
  const sets: PokemonSet[] = [];
  const kept: FoeMon[] = [];
  for (const mon of foes) {
    if (sets.length >= 6) break;
    const set = toSet(mon.species, mon.moves || [], mon.level || 80, mon.ability, mon.item);
    if (!set) continue;
    sets.push(set);
    kept.push(mon);
  }
  if (sets.length === 0) {
    const filler = toSet('Magikarp', ['splash'], 80);
    if (filler) {
      sets.push(filler);
      kept.push({ species: 'Magikarp', level: 80, hp: 100, maxhp: 100, moves: ['splash'] });
    }
  }
  return { sets, kept };
}

/**
 * A @pkmn/sim battle whose `move N` / `switch N` indexes match the live request.
 * Slot 0 is the active pokemon. That is the same indexing the server uses.
 */
export function buildDecisionBattle(position: LivePosition, options?: { quickWins?: boolean }): Battle | null {
  const request = position.request;
  if (!request || request.wait || request.teamPreview) return null;
  const quickWins = options?.quickWins === true;
  const ours = ourSets(request, quickWins);
  const foe = foeSets(knownFoes(position));
  if (!ours || foe.sets.length === 0) return null;

  try {
    const battle = new Battle({
      formatid: 'gen9customgame' as any,
      seed: [1, 2, 3, 4] as any,
    });
    battle.setPlayer('p1', { name: 'P1', team: ours });
    battle.setPlayer('p2', { name: 'P2', team: foe.sets });
    if (battle.requestState === 'teampreview') {
      if (!battle.choose('p1', 'default') || !battle.choose('p2', 'default')) return null;
    }
    if (!battle.p1.active[0] || !battle.p2.active[0]) return null;

    const slots: any[] = request.side?.pokemon || [];
    battle.p1.pokemon.forEach((mon, i) => {
      const condition = slots[i]?.condition as string | undefined;
      const fainted = !!condition?.includes('fnt');
      const hp = condition?.match(/(\d+)\/(\d+)/);
      if (hp) applyFraction(mon, Number(hp[1]), Number(hp[2]), fainted);
      else if (fainted) applyFraction(mon, 0, 1, true);
      applyStatus(mon, condition, undefined);
      if (quickWins) {
        const already = slots[i]?.terastallized;
        if (typeof already === 'string' && already) mon.terastallized = already;
      }
    });
    if (quickWins && slots.some(slot => typeof slot?.terastallized === 'string' && slot.terastallized)) {
      for (const mon of battle.p1.pokemon) mon.canTerastallize = null;
    }

    battle.p2.pokemon.forEach((mon, i) => {
      const info = foe.kept[i];
      if (!info) return;
      applyFraction(mon, info.hp, info.maxhp, !!info.fainted);
      applyStatus(mon, undefined, info.status);
    });

    for (const side of [battle.p1, battle.p2]) {
      side.pokemonLeft = side.pokemon.filter(mon => !mon.fainted).length;
    }

    const active = battle.p1.active[0];
    const liveMoves: any[] = request.active?.[0]?.moves || [];
    for (let i = 0; i < liveMoves.length && i < active.moveSlots.length; i++) {
      if (liveMoves[i].disabled) active.moveSlots[i].disabled = true;
      if (liveMoves[i].pp === 0) active.moveSlots[i].pp = 0;
    }
    if (request.active?.[0]?.trapped || request.active?.[0]?.maybeTrapped) {
      active.trapped = true;
    }
    applyBoosts(active, position.ourBoosts);
    applyBoosts(battle.p2.active[0], position.foeActive?.boosts);

    const weather = WEATHER[(position.weather || '').toLowerCase()];
    if (weather) {
      try {
        battle.field.setWeather(weather as any);
      } catch {
        // Weather is a modifier. A failed set still leaves a legal request.
      }
    }

    if (quickWins) {
      // The fresh sim offers Tera whenever the set has a type. The live request
      // is the rule: once this side has terastallized, canTerastallize is gone.
      const liveCanTera = request.active?.[0]?.canTerastallize;
      if (typeof liveCanTera === 'string' && liveCanTera) {
        if (!active.terastallized) active.canTerastallize = liveCanTera;
      } else {
        for (const mon of battle.p1.pokemon) mon.canTerastallize = null;
      }
    }

    const force = isForceSwitch(request) || !!active.fainted;
    if (force) active.switchFlag = true;
    battle.makeRequest(force ? 'switch' : 'move');
    const reviving = (request.side?.pokemon || []).some((mon: { reviving?: boolean }) => mon?.reviving);
    if (reviving) {
      const slot = battle.p1.slotConditions[active.position] as Record<string, unknown>;
      if (slot) slot.revivalblessing = { id: 'revivalblessing' };
    }
    if (legalChoices(battle, 'p1').length === 0) return null;
    return battle;
  } catch {
    return null;
  }
}

/** A config-layer bot. The reconstructed battle is always our side as p1. */
export interface LiveConfigPlayer {
  decide(input: {
    battle: Battle;
    side: 'p1';
  }): Promise<{ choice: string; scores?: Array<{ choice: string; score: number }> }>;
  /** Exact 1-ply quick wins. The champion player leaves this unset. */
  quickWins?: boolean;
}

/**
 * One ladder decision. `search` / `exact` run exactSearch(EXACT_1PLY).
 * `max-damage` runs maxDamageChoice. A labeled champion, when passed,
 * chooses through that bot instead. The action is one of `legal`.
 */
export async function chooseLive(
  engine: EngineName,
  position: LivePosition | undefined,
  legal: Action[],
  player?: LiveConfigPlayer | null,
): Promise<{ action: Action; score: number | null }> {
  if (!position) throw new Error('missing live position');
  const battle = buildDecisionBattle(position, { quickWins: player?.quickWins === true });
  if (!battle) throw new Error('could not build a sim battle');
  const decision = player
    ? await player.decide({ battle, side: 'p1' })
    : await decide(ladderPolicy(engine), battle, 'p1', new PRNG([1, 2, 3, 4] as any));
  const action = actionFromChoice(decision.choice);
  if (!action || !legal.some(candidate => sameAction(candidate, action))) {
    throw new Error(`engine returned a choice that is not legal (${decision.choice})`);
  }
  const score = decision.scores?.find(row => row.choice === decision.choice)?.score ?? null;
  return { action, score };
}
