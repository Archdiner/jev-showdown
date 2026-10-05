import { Battle, Dex, PRNG, PokemonSet } from '@pkmn/sim';
import { Action, RandbatsStats } from '../types/index.js';
import { decide } from '../engine/exact/policies.js';
import { legalChoices, type SideId } from '../engine/exact/battle-utils.js';
import {
  completeFoeTeam,
  FOE_PRIOR_MIN_BUDGET_MS,
  loadedSpeciesStats,
} from '../engine/foe-prior.js';
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
  /** Revealed tera, used only to narrow the role posterior. */
  teraType?: string;
  /** Teammate that has not switched in. The set is the species prior. */
  placeholder?: boolean;
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
  /**
   * Randbats role table. When set, unrevealed moves, items, and abilities
   * are filled from it and unseen teammates become placeholders.
   */
  speciesStats?: RandbatsStats;
  /** Use the table the decision worker loaded, instead of `speciesStats`. */
  useLoadedPriors?: boolean;
  /** Keep the revealed-only foe even when a table is available. */
  modelHidden?: boolean;
}

export interface DecisionBuildOptions {
  /** Skip the prior when the caller has less than {@link FOE_PRIOR_MIN_BUDGET_MS}. */
  budgetMs?: number;
  /** Labeled champion. When set, it chooses on the battle this function built. */
  player?: LiveConfigPlayer | null;
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

function priorsEnabled(position: LivePosition, budgetMs?: number): boolean {
  if (position.modelHidden === false) return false;
  if (budgetMs != null && budgetMs < FOE_PRIOR_MIN_BUDGET_MS) return false;
  return position.speciesStats != null || position.useLoadedPriors === true;
}

function speciesTable(position: LivePosition): RandbatsStats | null {
  if (position.speciesStats) return position.speciesStats;
  if (position.useLoadedPriors) return loadedSpeciesStats();
  return null;
}

/** Revealed foes, with hidden sets filled in when a prior table is available. */
function modeledFoes(position: LivePosition, budgetMs?: number): FoeMon[] {
  const known = knownFoes(position);
  if (!priorsEnabled(position, budgetMs)) return known;
  const stats = speciesTable(position);
  if (!stats) return known;
  try {
    return completeFoeTeam(known, stats) as FoeMon[];
  } catch {
    return known;
  }
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
export function buildDecisionBattle(position: LivePosition, options?: DecisionBuildOptions): Battle | null {
  const request = position.request;
  if (!request || request.wait || request.teamPreview) return null;
  const ours = ourSets(request);
  const foe = foeSets(modeledFoes(position, options?.budgetMs));
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

/** A config-layer bot. The reconstructed battle is always our side as p1. */
export interface LiveConfigPlayer {
  decide(input: {
    battle: Battle;
    side: 'p1';
  }): Promise<{ choice: string; scores?: Array<{ choice: string; score: number }> }>;
}

/**
 * One ladder decision. `search` / `exact` run exactSearch(EXACT_1PLY).
 * `max-damage` runs maxDamageChoice. A labeled champion, when passed,
 * chooses through that bot instead. The action is one of `legal`.
 */
async function chooseFrom(
  engine: EngineName,
  position: LivePosition,
  legal: Action[],
  options?: DecisionBuildOptions,
): Promise<{ action: Action; score: number | null } | null> {
  const battle = buildDecisionBattle(position, options);
  if (!battle) return null;
  const decision = options?.player
    ? await options.player.decide({ battle, side: 'p1' })
    : await decide(ladderPolicy(engine), battle, 'p1', new PRNG([1, 2, 3, 4] as any));
  const action = actionFromChoice(decision.choice);
  if (!action || !legal.some(candidate => sameAction(candidate, action))) return null;
  const score = decision.scores?.find(row => row.choice === decision.choice)?.score ?? null;
  return { action, score };
}

export async function chooseLive(
  engine: EngineName,
  position: LivePosition | undefined,
  legal: Action[],
  options?: DecisionBuildOptions,
): Promise<{ action: Action; score: number | null }> {
  if (!position) throw new Error('missing live position');
  const picked = await chooseFrom(engine, position, legal, options);
  if (picked) return { action: picked.action, score: picked.score };
  // A richer foe that fails to build, or a choice the request rejects, plays
  // the revealed-only battle instead of the max-damage legal fallback.
  if (position.modelHidden !== false && (position.speciesStats || position.useLoadedPriors)) {
    const revealed = await chooseFrom(engine, {
      ...position,
      modelHidden: false,
      useLoadedPriors: false,
      speciesStats: undefined,
    }, legal, options);
    if (revealed) return { action: revealed.action, score: revealed.score };
  }
  const battle = buildDecisionBattle({ ...position, modelHidden: false });
  if (!battle) throw new Error('could not build a sim battle');
  throw new Error('engine returned a choice that is not legal');
}

/** Live explore arm. Factory and gatekeeper turn the same switch on with search.params.foePriors. */
export const FOE_PRIORS_VARIANT = 'foe-priors';

export function foePriorsEnabled(flag: boolean | undefined, variantId?: string): boolean {
  return flag === true || variantId === FOE_PRIORS_VARIANT;
}

/**
 * What a full sim battle has revealed in its log, shaped like a ladder position.
 * The search still sees our real request. Unrevealed foe slots stay empty.
 */
export function revealedLivePosition(battle: Battle, side: SideId): LivePosition {
  const foeId: SideId = side === 'p1' ? 'p2' : 'p1';
  const seen = new Map<string, { species: string; level: number; moves: string[]; ability?: string; item?: string }>();
  const speciesOf = new Map<string, string>();
  for (const line of battle.log) {
    if (!line.startsWith('|')) continue;
    const parts = line.split('|');
    const cmd = parts[1];
    if (cmd === 'switch' || cmd === 'drag' || cmd === 'replace') {
      const who = protocolWho(parts[2] || '');
      if (!who) continue;
      const details = parts[3] || '';
      const species = details.split(',')[0]?.trim() || who.nickname;
      const levelMatch = details.match(/L(\d+)/);
      speciesOf.set(`${who.side}:${who.nickname}`, species);
      const mon = seenMon(seen, species, levelMatch ? Number(levelMatch[1]) : 80);
      mon.species = species;
      if (levelMatch) mon.level = Number(levelMatch[1]);
      continue;
    }
    if (cmd === 'move') {
      const who = protocolWho(parts[2] || '');
      const move = parts[3] || '';
      if (!who || !move || move === 'Recharge') continue;
      const species = speciesOf.get(`${who.side}:${who.nickname}`) || who.nickname;
      const mon = seenMon(seen, species, 80);
      if (!mon.moves.includes(move)) mon.moves.push(move);
      continue;
    }
    if (cmd === '-ability') {
      const who = protocolWho(parts[2] || '');
      if (!who || !parts[3]) continue;
      const species = speciesOf.get(`${who.side}:${who.nickname}`) || who.nickname;
      seenMon(seen, species, 80).ability = parts[3];
      continue;
    }
    if (cmd === '-item' || cmd === '-enditem') {
      const who = protocolWho(parts[2] || '');
      if (!who || !parts[3]) continue;
      const species = speciesOf.get(`${who.side}:${who.nickname}`) || who.nickname;
      seenMon(seen, species, 80).item = parts[3];
    }
  }

  const foeSide = battle.getSide(foeId);
  const ourSide = battle.getSide(side);
  const active = foeSide.active[0];
  const snap = (mon: typeof active, reveal: { moves: string[]; ability?: string; item?: string } | undefined) => {
    if (!mon) return null;
    return {
      species: mon.species.name,
      level: mon.level,
      hp: mon.hp,
      maxhp: mon.maxhp,
      status: mon.status || undefined,
      ability: reveal?.ability,
      item: reveal?.item,
      moves: reveal?.moves ? [...reveal.moves] : [],
      boosts: {
        atk: mon.boosts.atk,
        def: mon.boosts.def,
        spa: mon.boosts.spa,
        spd: mon.boosts.spd,
        spe: mon.boosts.spe,
      },
      fainted: mon.fainted || mon.hp <= 0,
    };
  };
  const foeActive = active ? snap(active, seen.get(active.species.name)) : null;
  const foeBench = foeSide.pokemon
    .filter(mon => mon && mon !== active)
    .map(mon => {
      const reveal = seen.get(mon.species.name);
      if (!reveal) return null;
      return snap(mon, reveal);
    })
    .filter((mon): mon is NonNullable<typeof mon> => !!mon);
  const ours = ourSide.active[0];
  return {
    request: battle.getSide(side).activeRequest,
    foeActive,
    foeBench,
    ourBoosts: ours ? {
      atk: ours.boosts.atk,
      def: ours.boosts.def,
      spa: ours.boosts.spa,
      spd: ours.boosts.spd,
      spe: ours.boosts.spe,
    } : undefined,
    weather: battle.field.weather ? String(battle.field.weather) : undefined,
    speciesStats: undefined,
  };
}

/** Hidden-info copy. Our side is p1 so `move N` matches the live request. Null keeps the real battle. */
export function battleWithFoePriors(battle: Battle, side: SideId, stats: RandbatsStats): Battle | null {
  const position = revealedLivePosition(battle, side);
  if (!position.request) return null;
  position.speciesStats = stats;
  return buildDecisionBattle(position);
}

function seenMon(
  seen: Map<string, { species: string; level: number; moves: string[]; ability?: string; item?: string }>,
  species: string,
  level: number,
): { species: string; level: number; moves: string[]; ability?: string; item?: string } {
  const existing = seen.get(species);
  if (existing) return existing;
  const created = { species, level, moves: [] as string[] };
  seen.set(species, created);
  return created;
}

function protocolWho(ident: string): { side: SideId; nickname: string } | null {
  const side: SideId | null = ident.startsWith('p2') ? 'p2' : ident.startsWith('p1') ? 'p1' : null;
  if (!side) return null;
  const nickname = ident.split(':').slice(1).join(':').trim() || ident;
  return { side, nickname };
}
