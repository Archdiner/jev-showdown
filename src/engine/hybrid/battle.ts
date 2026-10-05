import { Battle, PokemonSet, type ID } from '@pkmn/sim';
import type { FoeMon, LivePosition } from '../../client/decision-battle.js';
import { legalChoices, type SideId } from '../exact/battle-utils.js';
import type { WorldSample } from './worlds.js';

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

/**
 * A fresh sim whose opponent team is one sampled world.
 * Our side is copied from the public decision battle, including HP and Tera.
 */
export function battleFromWorld(viewed: Battle, world: WorldSample, evidence?: LivePosition | null): Battle | null {
  const ours = setsOf(viewed, 'p1');
  if (ours.length === 0 || world.foeTeam.length === 0) return null;
  try {
    const battle = new Battle({ formatid: 'gen9customgame' as never, seed: [1, 2, 3, 4] as never });
    battle.setPlayer('p1', { name: 'P1', team: ours });
    battle.setPlayer('p2', { name: 'P2', team: world.foeTeam });
    if (battle.requestState === 'teampreview') {
      if (!battle.choose('p1', 'default') || !battle.choose('p2', 'default')) return null;
    }
    if (!battle.p1.active[0] || !battle.p2.active[0]) return null;
    copySideState(viewed.p1, battle.p1);
    copyFoeState(viewed, battle, evidence?.foeActive ? [evidence.foeActive, ...(evidence.foeBench || [])] : []);
    copyField(viewed, battle, evidence);
    const force = Boolean((viewed.p1.active[0] as { switchFlag?: boolean } | null)?.switchFlag)
      || Boolean(viewed.p1.active[0]?.fainted);
    if (force && battle.p1.active[0]) battle.p1.active[0].switchFlag = true;
    const request = viewed.p1.activeRequest as { active?: Array<{ canTerastallize?: string }> } | null;
    if (!request?.active?.[0]?.canTerastallize) {
      for (const mon of battle.p1.pokemon) mon.canTerastallize = null as never;
    }
    battle.makeRequest(force ? 'switch' : 'move');
    if (typeof viewed.turn === 'number') battle.turn = viewed.turn;
    if (legalChoices(battle, 'p1').length === 0 && legalChoices(battle, 'p1', { tera: true }).length === 0) return null;
    return battle;
  } catch {
    return null;
  }
}

function setsOf(battle: Battle, side: SideId): PokemonSet[] {
  return battle.getSide(side).pokemon.map(mon => ({
    species: mon.species.name,
    moves: mon.moveSlots.map(slot => slot.move).filter(Boolean).slice(0, 4),
    ability: mon.ability || mon.baseAbility || '',
    item: mon.item || '',
    nature: 'Hardy',
    evs: { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 },
    level: mon.level || 80,
    ...(mon.teraType ? { teraType: mon.teraType } : {}),
  } as PokemonSet)).filter(set => set.moves.length > 0 || set.species);
}

function copySideState(from: Battle['p1'], to: Battle['p1']): void {
  to.pokemon.forEach((mon, index) => {
    const source = from.pokemon[index];
    if (!source) return;
    copyHp(mon, source.hp, source.maxhp, source.fainted);
    if (source.status && !mon.fainted) {
      try { mon.setStatus(source.status); } catch { mon.status = source.status; }
    }
    if (source.terastallized) {
      mon.teraType = source.teraType || source.terastallized;
      mon.terastallized = source.terastallized;
      mon.canTerastallize = null as never;
    }
  });
  const activeFrom = from.active[0];
  const activeTo = to.active[0];
  if (activeFrom && activeTo) {
    for (const stat of ['atk', 'def', 'spa', 'spd', 'spe'] as const) {
      activeTo.boosts[stat] = activeFrom.boosts[stat] || 0;
    }
    activeFrom.moveSlots.forEach((slot, index) => {
      const target = activeTo.moveSlots[index];
      if (!target) return;
      if (slot.disabled) target.disabled = true;
      if (slot.pp === 0) target.pp = 0;
    });
    if (activeFrom.trapped) activeTo.trapped = true;
  }
  to.pokemonLeft = to.pokemon.filter(mon => !mon.fainted).length;
}

function copyFoeState(viewed: Battle, battle: Battle, known: FoeMon[]): void {
  battle.p2.pokemon.forEach((mon, index) => {
    const info = known[index];
    const viewedMon = viewed.p2.pokemon.find(candidate => candidate.species.name === mon.species.name) || viewed.p2.pokemon[index];
    if (info) copyHp(mon, info.hp, info.maxhp, !!info.fainted);
    else if (viewedMon) copyHp(mon, viewedMon.hp, viewedMon.maxhp, viewedMon.fainted);
    const status = info?.status || viewedMon?.status;
    if (status && !mon.fainted) {
      try { mon.setStatus(status as ID); } catch { mon.status = status as ID; }
    }
    const tera = info?.terastallized || viewedMon?.terastallized;
    if (tera) {
      mon.teraType = tera;
      mon.terastallized = tera;
    }
  });
  const boosts = known[0]?.boosts || viewed.p2.active[0]?.boosts;
  const active = battle.p2.active[0];
  if (active && boosts) {
    for (const stat of ['atk', 'def', 'spa', 'spd', 'spe'] as const) {
      if (typeof boosts[stat] === 'number') active.boosts[stat] = boosts[stat];
    }
  }
  battle.p2.pokemonLeft = battle.p2.pokemon.filter(mon => !mon.fainted).length;
}

function copyField(viewed: Battle, battle: Battle, evidence?: LivePosition | null): void {
  const weather = WEATHER[(evidence?.weather || (viewed.field as { weather?: string }).weather || '').toLowerCase()];
  if (weather) {
    try { battle.field.setWeather(weather as never); } catch { /* modifier only */ }
  }
  for (const id of evidence?.myHazards || []) addHazard(battle.p1, id);
  for (const id of evidence?.foeHazards || []) addHazard(battle.p2, id);
}

function addHazard(side: Battle['p1'], id: string): void {
  try {
    side.addSideCondition(id as never);
  } catch {
    // The search still runs. A missing hazard is a modifier, not a crash.
  }
}

function copyHp(mon: { hp: number; maxhp: number; fainted: boolean }, hp: number, maxhp: number, fainted: boolean): void {
  if (fainted || hp <= 0) {
    mon.hp = 0;
    mon.fainted = true;
    return;
  }
  if (maxhp > 0 && mon.maxhp > 0) mon.hp = Math.max(1, Math.round(mon.maxhp * (hp / maxhp)));
}
