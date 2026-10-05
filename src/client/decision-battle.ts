import { Battle, Dex, PRNG, PokemonSet } from '@pkmn/sim';
import { Action, RandbatsStats } from '../types/index.js';
import { decide } from '../engine/exact/policies.js';
import { legalChoices } from '../engine/exact/battle-utils.js';
import { EngineName } from './engines.js';
import { sameAction } from './choice.js';
import { ladderPolicy } from './ladder-engine.js';
import { 
  determinizedSearch, 
  type DetConfig, 
  type WorldEvidence 
} from '../engine/exact/search.js';
import { type WorldSample } from '../engine/exact/worlds.js';
import { dataLoader } from '../data/data-loader.js';

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
  if (move) return { type: 'move', moveIndex: Number(move[1]) };
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

function toSet(species: string, moves: string[], level: number, ability?: string, item?: string): PokemonSet | null {
  const speciesName = named('species', species);
  if (!speciesName) return null;
  const moveNames = moves.map(move => named('moves', move)).filter(Boolean).slice(0, 4);
  if (moveNames.length === 0) moveNames.push('Tackle');
  const dexSpecies = Dex.species.get(speciesName);
  return {
    species: speciesName,
    moves: moveNames,
    ability: named('abilities', ability) || dexSpecies.abilities?.['0'] || 'Pressure',
    item: named('items', item) || '',
    nature: 'Hardy',
    evs: { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 },
    level: level || 80,
  } as PokemonSet;
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

function ourSets(request: any): PokemonSet[] | null {
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
    const set = toSet(
      speciesOf(slot.details, slot.ident),
      moves,
      levelOf(slot.details, slot.level || 80),
      slot.ability || slot.baseAbility,
      slot.item,
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
export function buildDecisionBattle(position: LivePosition): Battle | null {
  const request = position.request;
  if (!request || request.wait || request.teamPreview) return null;
  const ours = ourSets(request);
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
    });

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

    const force = isForceSwitch(request) || !!active.fainted;
    if (force) active.switchFlag = true;
    battle.makeRequest(force ? 'switch' : 'move');
    if (legalChoices(battle, 'p1').length === 0) return null;
    return battle;
  } catch {
    return null;
  }
}

/**
 * Build a battle from our side's request and a sampled opponent world.
 * Our team comes from the request; the opponent team is the world sample.
 */
function buildBattleFromWorld(
  position: LivePosition,
  world: WorldSample,
): Battle | null {
  const request = position.request;
  if (!request || request.wait || request.teamPreview) return null;
  const ours = ourSets(request);
  if (!ours) return null;

  try {
    const battle = new Battle({
      formatid: 'gen9customgame' as any,
      seed: [1, 2, 3, 4] as any,
    });
    battle.setPlayer('p1', { name: 'P1', team: ours });
    battle.setPlayer('p2', { name: 'P2', team: world.foeTeam });
    
    if (battle.requestState === 'teampreview') {
      if (!battle.choose('p1', 'default') || !battle.choose('p2', 'default')) return null;
    }
    if (!battle.p1.active[0] || !battle.p2.active[0]) return null;

    // Apply our side's HP, status, boosts from the request
    const slots: any[] = request.side?.pokemon || [];
    battle.p1.pokemon.forEach((mon, i) => {
      const condition = slots[i]?.condition as string | undefined;
      const fainted = !!condition?.includes('fnt');
      const hp = condition?.match(/(\d+)\/(\d+)/);
      if (hp) applyFraction(mon, Number(hp[1]), Number(hp[2]), fainted);
      else if (fainted) applyFraction(mon, 0, 1, true);
      applyStatus(mon, condition, undefined);
    });

    // Apply foe HP/status for revealed mons from LivePosition
    const knownFoesList = knownFoes(position);
    battle.p2.pokemon.forEach((mon, i) => {
      const info = knownFoesList[i];
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

    const force = isForceSwitch(request) || !!active.fainted;
    if (force) active.switchFlag = true;
    battle.makeRequest(force ? 'switch' : 'move');
    if (legalChoices(battle, 'p1').length === 0) return null;
    return battle;
  } catch {
    return null;
  }
}

/**
 * Determinized exact search decision from a LivePosition.
 * Samples K opponent worlds and aggregates exact search across them.
 */
export async function chooseDeterminized(
  position: LivePosition,
  config: DetConfig,
  stats: RandbatsStats,
): Promise<{ choice: string; score: number; worldsCompleted: number }> {
  const evidence: WorldEvidence = {
    knownFoes: knownFoes(position),
    teamSize: 6,
  };

  const rng = new PRNG([1, 2, 3, 4] as any);
  
  const buildBattle = (world: WorldSample) => buildBattleFromWorld(position, world);
  
  const trace = determinizedSearch(evidence, buildBattle, 'p1', config, stats, rng);
  
  const best = trace.scores[0] || { choice: 'default', score: 0 };
  return {
    choice: trace.choice,
    score: best.score,
    worldsCompleted: trace.worldsCompleted ?? 0,
  };
}

/**
 * One ladder decision. `search` / `exact` run exactSearch(EXACT_1PLY).
 * `max-damage` runs maxDamageChoice. The action is one of `legal`.
 */
export async function chooseLive(
  engine: EngineName,
  position: LivePosition | undefined,
  legal: Action[],
): Promise<{ action: Action; score: number | null }> {
  if (!position) throw new Error('missing live position');
  const battle = buildDecisionBattle(position);
  if (!battle) throw new Error('could not build a sim battle');
  const decision = await decide(ladderPolicy(engine), battle, 'p1', new PRNG([1, 2, 3, 4] as any));
  const action = actionFromChoice(decision.choice);
  if (!action || !legal.some(candidate => sameAction(candidate, action))) {
    throw new Error(`engine returned a choice that is not legal (${decision.choice})`);
  }
  const score = decision.scores?.find(row => row.choice === decision.choice)?.score ?? null;
  return { action, score };
}
