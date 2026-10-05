import { Battle, Dex, Teams } from '@pkmn/sim';
import { expectedDamage } from './max-damage.js';
import {
  SideId,
  cloneFromSnapshot,
  ensureGenerators,
  otherSide,
  snapshot,
} from './battle-utils.js';

/**
 * Ladder decisions only see what the protocol has revealed. These helpers
 * keep 1-ply from clicking a move the public board already refutes, and
 * from treating an empty foe movepool as Tackle.
 *
 * Scales are a fraction of one faint (hp eval charges 2 for a KO). They
 * are not fit to a species or a replay.
 */

const CHOICE_ITEMS = new Set(['choiceband', 'choicescarf', 'choicespecs']);

/** Ability id -> move types that ability blanks. */
const ABILITY_IMMUNE: Record<string, readonly string[]> = {
  levitate: ['Ground'],
  eartheater: ['Ground'],
  flashfire: ['Fire'],
  wellbakedbody: ['Fire'],
  waterabsorb: ['Water'],
  stormdrain: ['Water'],
  dryskin: ['Water'],
  voltabsorb: ['Electric'],
  lightningrod: ['Electric'],
  motordrive: ['Electric'],
  sapsipper: ['Grass'],
};

let setsCache: Record<string, { sets?: Array<{ movepool?: string[] }> }> | null = null;

function randbats(): typeof setsCache {
  if (setsCache) return setsCache;
  ensureGenerators();
  const gen = Teams.getGenerator('gen9randombattle') as { randomSets?: typeof setsCache };
  setsCache = gen.randomSets || {};
  return setsCache;
}

export function randbatsSpeciesCount(): number {
  return Object.keys(randbats() || {}).length;
}

function setId(species: string): string {
  return Dex.species.get(species).id;
}

function damaging(id: string): boolean {
  const move = Dex.moves.get(id);
  return Boolean(move.exists && move.category !== 'Status' && move.basePower);
}

/**
 * A damaging move the defender publicly blanks: typing, an immunity
 * ability, Wonder Guard, or an Air Balloon that is already known.
 */
export function damagingImmune(moveId: string, defender: any, typeOverride?: string): boolean {
  const move = Dex.moves.get(moveId);
  if (!move.exists || move.category === 'Status' || !move.basePower) return false;
  const type = typeOverride || move.type;
  const types: string[] = defender?.getTypes?.() || defender?.types || [];
  if (types.length > 0 && Dex.getImmunity(type, types) === false) return true;
  const ability = String(defender?.ability || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (ABILITY_IMMUNE[ability]?.includes(type)) return true;
  if (ability === 'wonderguard' && types.length > 0 && Dex.getEffectiveness(type, types) <= 0) return true;
  if (defender?.item === 'airballoon' && type === 'Ground') return true;
  return false;
}

function effectiveSpeed(mon: any): number {
  const base = mon?.storedStats?.spe || mon?.species?.baseStats?.spe || 0;
  const stage = mon?.boosts?.spe || 0;
  const mult = stage >= 0 ? (2 + stage) / 2 : 2 / (2 - stage);
  let speed = base * mult;
  if (mon?.item === 'choicescarf') speed *= 1.5;
  if (mon?.status === 'par') speed *= 0.5;
  return speed;
}

function moveTypeForChoice(choice: string, mon: any, moveId: string): string | undefined {
  if (!choice.includes('terastallize') || moveId !== 'terablast') return undefined;
  const tera = mon?.teraType || mon?.canTerastallize;
  return typeof tera === 'string' && tera ? tera : undefined;
}

/**
 * Penalty subtracted from a 1-ply score.
 * Immune attacks lose to any move that connects. Status loses to an
 * attack when the foe's listed moves already KO us before we move.
 * A Choice item loses to a move that still hits when a benched foe
 * walls the lock.
 */
export function progressPenalty(battle: Battle, side: SideId, choice: string): number {
  if (!choice.startsWith('move ')) return 0;
  const us = battle.getSide(side);
  const mon = us.active[0];
  const foeSide = us.foe;
  const foe = foeSide?.active?.[0];
  if (!mon || !foe) return 0;
  const index = Number(choice.split(' ')[1]) - 1;
  const moveId = mon.moveSlots[index]?.id;
  if (!moveId) return 0;
  const move = Dex.moves.get(moveId);
  if (!move.exists) return 0;

  let penalty = 0;
  if (damaging(moveId) && damagingImmune(moveId, foe, moveTypeForChoice(choice, mon, moveId))) {
    penalty += 1.1;
  }

  if (move.category === 'Status' && foeThreatensKo(battle, side)) penalty += 0.9;

  if (CHOICE_ITEMS.has(String(mon.item || '')) && damaging(moveId) && !choice.includes('terastallize')) {
    const benchWalled = foeSide.pokemon.some(other => {
      if (!other || other.fainted || other.isActive) return false;
      return damagingImmune(moveId, other);
    });
    const otherHits = mon.moveSlots.some(slot => {
      if (!slot?.id || slot.id === moveId || slot.disabled) return false;
      return damaging(slot.id) && !damagingImmune(slot.id, foe);
    });
    if (benchWalled && otherHits) penalty += 0.5;
  }
  return penalty;
}

function foeThreatensKo(battle: Battle, side: SideId): boolean {
  const us = battle.getSide(side).active[0];
  const foe = battle.getSide(side).foe.active[0];
  if (!us || !foe || us.hp <= 0 || foe.hp <= 0) return false;
  const weather = (battle.field as { weather?: { id?: string } }).weather?.id;
  const foeSpe = effectiveSpeed(foe);
  const ourSpe = effectiveSpeed(us);
  for (const slot of foe.moveSlots || []) {
    if (!slot?.id || !damaging(slot.id)) continue;
    const move = Dex.moves.get(slot.id);
    const damage = expectedDamage(foe, us, slot.id, weather);
    if (damage < us.hp) continue;
    if ((move.priority || 0) > 0 || foeSpe > ourSpe) return true;
  }
  return false;
}

function poolFor(species: string, revealed: string[]): string[] {
  const sets = randbats()?.[setId(species)]?.sets || [];
  const asId = (name: string) => {
    const move = Dex.moves.get(name);
    return move.exists ? String(move.id) : '';
  };
  const revealedIds = revealed.map(asId).filter(Boolean);
  let pool: string[] = [];
  for (const set of sets) {
    const ids = (set.movepool || []).map(asId).filter(Boolean);
    if (revealedIds.every(id => ids.includes(id))) {
      pool = ids;
      break;
    }
  }
  if (pool.length === 0 && sets[0]?.movepool) {
    pool = sets[0].movepool.map(asId).filter(Boolean);
  }
  const picked = [...revealedIds];
  for (const id of pool) {
    if (picked.length >= 4) break;
    if (!damaging(id) || picked.includes(id)) continue;
    picked.push(id);
  }
  if (picked.length === 0) picked.push('tackle');
  return picked.slice(0, 4);
}

function writeMoves(mon: any, moveIds: string[]): void {
  const slots = [];
  for (const id of moveIds) {
    const move = Dex.moves.get(id);
    if (!move.exists) continue;
    const pp = move.noPPBoosts ? move.pp : Math.floor(move.pp * 8 / 5);
    slots.push({
      move: move.name,
      id: move.id,
      pp,
      maxpp: pp,
      target: move.target,
      disabled: false,
      disabledSource: '',
      used: false,
    });
  }
  if (slots.length === 0) return;
  mon.moveSlots = slots;
  mon.baseMoveSlots = slots;
}

/** Four real moves, at least two of them damaging: the sim already has a set. */
export function hasCompleteMovepool(mon: any): boolean {
  const slots = mon?.moveSlots || [];
  if (slots.length < 4) return false;
  const hits = slots.filter((slot: any) => slot?.id && damaging(slot.id) && slot.id !== 'tackle' && slot.id !== 'struggle');
  return hits.length >= 2;
}

/**
 * Replace an incomplete foe movepool with one randbats set that contains
 * every move already used. Complete sets are left alone, so a full-info
 * battle does not grow extra coverage.
 */
export function applyFoePrior(battle: Battle, side: SideId): void {
  const foe = battle.getSide(otherSide(side));
  let changed = false;
  for (const mon of foe.pokemon) {
    if (!mon || mon.fainted || hasCompleteMovepool(mon)) continue;
    // Incomplete boards are already the revealed list (or a Tackle placeholder).
    // Usage PP is not a signal here: the live builder and revealOnly both
    // store those moves at full PP.
    const revealed = (mon.moveSlots || [])
      .map((slot: any) => slot?.id as string)
      .filter(id => id && id !== 'tackle' && id !== 'struggle');
    writeMoves(mon, poolFor(mon.species.name, revealed));
    changed = true;
  }
  if (!changed) return;
  const state = battle.requestState;
  if (state === 'move' || state === 'switch') battle.makeRequest(state);
}

/**
 * Clone whose foe only has moves that have already been used.
 * An unused board becomes Tackle, which is what the live builder
 * substitutes when the protocol has not revealed a move.
 */
export function revealOnly(battle: Battle, side: SideId): Battle {
  const clone = cloneFromSnapshot(snapshot(battle));
  const foe = clone.getSide(otherSide(side));
  for (const mon of foe.pokemon) {
    if (!mon || mon.fainted) continue;
    const used = (mon.moveSlots || [])
      .filter((slot: any) => slot && (slot.pp < slot.maxpp || slot.used))
      .map((slot: any) => slot.id as string);
    writeMoves(mon, used.length > 0 ? used : ['tackle']);
  }
  const state = clone.requestState;
  if (state === 'move' || state === 'switch') clone.makeRequest(state);
  return clone;
}
