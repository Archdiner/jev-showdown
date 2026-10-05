import { Dex } from '@pkmn/dex';
import { Move, Pokemon, Field, calculate } from '@smogon/calc';
import type { PokemonBelief, RandbatsStats, RoleData, SpeciesStats } from '../../types/index.js';
import { effectiveSpeed } from '../battle-facts.js';
import { battleSpecies } from '../../engine/exact/species.js';
import type { BoardInput, BoardMon, FactCache, RollLine, SetFact, StatSpread } from './types.js';

const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
const ASSUMED_EVS: StatSpread = { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 };
const ASSUMED_NATURE = 'Serious';

export function buildFacts(board: BoardInput): FactCache {
  const mine = alive(board.myTeam);
  const foes = alive(board.opponentTeam);
  const myActive = board.myTeam[board.myActive];
  const foeActive = board.opponentTeam[board.opponentActive];
  const field = calcField(board);
  const ourAttacks: RollLine[] = [];
  const foeAttacks: RollLine[] = [];
  const teraAttacks: RollLine[] = [];

  if (myActive && !myActive.fainted) {
    const moves = myActive.moveSlots.length > 0 ? myActive.moveSlots : myActive.knownMoves;
    for (const moveName of moves) {
      for (const foe of foes) {
        ourAttacks.push(roll(myActive, foe, moveName, field, board.pools, false));
      }
      if (board.canTera && myActive.teraKnown && myActive.teraType && foeActive) {
        teraAttacks.push(roll(myActive, foeActive, moveName, field, board.pools, true));
      }
    }
  }

  for (const foe of foes) {
    const moves = likelyMoveNames(foe, poolFor(foe, board.pools)).slice(0, 4);
    for (const moveName of moves) {
      for (const target of mine) {
        foeAttacks.push(roll(foe, target, moveName, field, board.pools, false));
      }
    }
  }

  const teraDefense: RollLine[] = [];
  if (myActive && !myActive.fainted && foeActive && board.canTera && myActive.teraKnown && myActive.teraType) {
    const moves = likelyMoveNames(foeActive, poolFor(foeActive, board.pools)).slice(0, 4);
    for (const moveName of moves) teraDefense.push(roll(foeActive, myActive, moveName, field, board.pools, false, true));
  }

  const speed = speedText(myActive, foeActive, board);
  const ourBest = bestRoll(ourAttacks, myActive?.species, foeActive?.species);
  const foeBest = bestRoll(foeAttacks, foeActive?.species, myActive?.species);
  const threatened = koNow(foeBest, myActive) || foeAttacks.some(line => line.defender === myActive?.species && line.maxPct >= 50);

  return {
    ourAttacks,
    foeAttacks,
    teraAttacks,
    teraDefense,
    speed,
    threat: threatText(speed, ourBest, foeBest, myActive),
    sets: [...board.myTeam, ...board.opponentTeam].map(mon => setFact(mon, board.pools)),
    threatened,
  };
}

function bestRoll(rows: RollLine[], attacker: string | undefined, defender: string | undefined): RollLine | undefined {
  if (!attacker || !defender) return undefined;
  const hits = rows.filter(row => row.attacker === attacker && row.defender === defender && row.maxPct > 0);
  hits.sort((a, b) => b.maxPct - a.maxPct || a.move.localeCompare(b.move));
  return hits[0];
}

function koNow(row: RollLine | undefined, defender: BoardMon | undefined): boolean {
  if (!row || defender?.hpPercent == null) return false;
  return row.maxPct >= defender.hpPercent;
}

function threatText(speed: string, ourBest: RollLine | undefined, foeBest: RollLine | undefined, mine: BoardMon | undefined): string {
  const foeKo = koNow(foeBest, mine);
  return [
    `speed ${speed}`,
    ourBest ? `our-best ${ourBest.text}` : 'our-best none',
    foeBest ? `foe-best ${foeBest.text}` : 'foe-best none',
    `active KO threat: ${foeBest ? (foeKo ? 'yes' : 'no') : 'unknown'}`,
  ].join('\n');
}

export function likelyMoveNames(mon: BoardMon, stats: SpeciesStats | undefined): string[] {
  const role = topRole(mon, stats);
  const table = role?.data.moves ?? {};
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (name: string) => {
    const id = Dex.moves.get(name).id;
    if (!id || seen.has(id)) return;
    seen.add(id);
    names.push(Dex.moves.get(name).exists ? Dex.moves.get(name).name : name);
  };
  for (const move of mon.knownMoves) add(move);
  const ranked = Object.entries(table)
    .filter(([, weight]) => weight > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
  for (const move of ranked) add(move);
  return names.slice(0, 6);
}

function roll(
  attackerMon: BoardMon,
  defenderMon: BoardMon,
  moveName: string,
  field: Field,
  pools: RandbatsStats,
  attackerTera: boolean,
  defenderTera = false,
): RollLine {
  const move = Dex.moves.get(moveName);
  const label = move.exists ? move.name : moveName;
  const base = `${label} -> ${defenderMon.species}`;
  if (!move.exists) {
    return { move: label, attacker: attackerMon.species, defender: defenderMon.species, text: `${base} unknown`, minPct: 0, maxPct: 0 };
  }
  const accuracy = move.accuracy === true ? 100 : Number(move.accuracy);
  const info = `t=${move.type} ${move.category} bp=${move.basePower || 0} acc=${accuracy} pri=${move.priority}`;
  if (move.category === 'Status' || !move.basePower) {
    return {
      move: label,
      attacker: attackerMon.species,
      defender: defenderMon.species,
      text: `${base} ${info} status koNow=no`,
      minPct: 0,
      maxPct: 0,
    };
  }
  try {
    const result = calculate(
      9,
      toCalc(attackerMon, pools, attackerTera),
      toCalc(defenderMon, pools, defenderTera),
      new Move(9, label),
      field
    );
    const [min, max] = result.range();
    const maxHp = result.defender.maxHP();
    const pct = (value: number) => (maxHp > 0 ? Math.round((value / maxHp) * 1000) / 10 : 0);
    const minPct = pct(min);
    const maxPct = pct(max);
    const hp = defenderMon.hpPercent;
    const koNow = hp != null && maxPct >= hp;
    const koSure = hp != null && minPct >= hp;
    let ko = 'ko=?';
    try {
      ko = result.kochance().text;
    } catch {
      ko = 'ko=?';
    }
    const tera = attackerTera ? ' tera' : defenderTera ? ' vs-tera' : '';
    return {
      move: label,
      attacker: attackerMon.species,
      defender: defenderMon.species,
      text: `${base}${tera} ${info} dmg=${minPct}-${maxPct}% hp=${hp ?? '?'}% koNow=${koNow ? 'yes' : 'no'} sure=${koSure ? 'yes' : 'no'} ${ko}`,
      minPct,
      maxPct,
    };
  } catch {
    return {
      move: label,
      attacker: attackerMon.species,
      defender: defenderMon.species,
      text: `${base} ${info} no-roll koNow=no`,
      minPct: 0,
      maxPct: 0,
    };
  }
}

function speedText(mine: BoardMon | undefined, foe: BoardMon | undefined, board: BoardInput): string {
  if (!mine || !foe) return 'speed unknown';
  const mineSpeed = speedOf(mine, board.pools, mine.itemKnown ? mine.item : undefined);
  const foeSpeed = speedOf(foe, board.pools, foe.itemKnown ? foe.item : undefined);
  const scarf = scarfPossible(foe, board.pools);
  const foeScarf = scarf.possible && !foe.itemKnown ? Math.floor(foeSpeed.value * 1.5) : foeSpeed.value;
  let order: string;
  if (board.field.trickRoom) {
    order = mineSpeed.value === foeSpeed.value
      ? 'speed tie under trick room'
      : mineSpeed.value < foeSpeed.value
        ? `${mine.species} first under trick room`
        : `${foe.species} first under trick room`;
  } else if (mineSpeed.value === foeSpeed.value) {
    order = 'speed tie before priority and scarf';
  } else if (mineSpeed.value > foeSpeed.value) {
    order = scarf.possible && !foe.itemKnown && foeScarf > mineSpeed.value
      ? `${mine.species} first unless ${foe.species} is scarfed (${foeScarf})`
      : `${mine.species} first`;
  } else {
    order = `${foe.species} first`;
  }
  const priority = priorityText(mine, foe, board.pools);
  return [
    `${mine.species}=${mineSpeed.detail}`,
    `${foe.species}=${foeSpeed.detail}`,
    scarf.possible && !foe.itemKnown ? `foeScarf=${foeScarf} scarfWeight=${scarf.weight}` : 'foeScarf=not-in-pool-or-known',
    order,
    priority,
  ].join(' | ');
}

function priorityText(mine: BoardMon, foe: BoardMon, pools: RandbatsStats): string {
  const ours = mine.moveSlots
    .map(name => ({ name, pri: Dex.moves.get(name).priority }))
    .filter(move => move.pri);
  const theirs = likelyMoveNames(foe, poolFor(foe, pools))
    .map(name => ({ name, pri: Dex.moves.get(name).priority }))
    .filter(move => move.pri);
  const fmt = (rows: Array<{ name: string; pri: number }>) =>
    rows.length ? rows.map(row => `${row.name}:${row.pri}`).join(',') : 'none';
  return `priority ours=${fmt(ours)} foe=${fmt(theirs)}`;
}

function speedOf(mon: BoardMon, pools: RandbatsStats, item: string | undefined): { value: number; detail: string } {
  const species = Dex.species.get(mon.species);
  const base = species.exists ? species.baseStats.spe : 0;
  const spread = spreadFor(mon, poolFor(mon, pools));
  const stage = mon.boosts.spe ?? 0;
  const value = species.exists ? effectiveSpeed(base, mon.level, spread.evs.spe, spread.nature, item, stage) : 0;
  return {
    value,
    detail: `${value} lv=${mon.level} nature=${spread.nature} speEV=${spread.evs.spe} item=${item ?? 'unknown'} speBoost=${stage} src=${spread.source}`,
  };
}

function scarfPossible(mon: BoardMon, pools: RandbatsStats): { possible: boolean; weight: string } {
  if (mon.itemKnown) return { possible: mon.item === 'Choice Scarf', weight: mon.item === 'Choice Scarf' ? '1' : '0' };
  const stats = poolFor(mon, pools);
  const weights = new Map<string, number>();
  for (const role of narrowedRoles(mon, stats)) {
    for (const [item, weight] of Object.entries(role.data.items ?? {})) {
      if (Dex.items.get(item).name === 'Choice Scarf') weights.set(item, (weights.get(item) ?? 0) + role.probability * weight);
    }
  }
  const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  return { possible: total > 0, weight: total > 0 ? total.toFixed(2) : '0' };
}

function poolFor(mon: BoardMon, pools: RandbatsStats): SpeciesStats | undefined {
  return pools[mon.species] ?? pools[battleSpecies(mon.species)];
}

function setFact(mon: BoardMon, pools: RandbatsStats): SetFact {
  const stats = poolFor(mon, pools);
  if (!stats) {
    return { species: mon.species, side: mon.moveSlots.length > 0 ? 'mine' : 'opponent', text: `${mon.species} no randbats row` };
  }
  const roles = narrowedRoles(mon, stats).slice(0, 2);
  const ability = mon.abilityKnown ? `${mon.ability} known` : weightsText(stats.abilities);
  const body = roles.length
    ? roles.map(role => {
        const items = mon.itemKnown ? `${mon.item} known` : weightsText(role.data.items);
        const tera = mon.teraKnown ? `${mon.teraType} known` : weightsText(role.data.teraTypes);
        const moves = weightsText(role.data.moves, 6);
        return `${role.name} w=${fmtWeight(role.probability)} item ${items} tera ${tera} moves ${moves}`;
      }).join(' || ')
    : 'no role matches reveals';
  const side = mon.moveSlots.length > 0 || mon.evs ? 'mine' : 'opponent';
  return { species: mon.species, side, text: `${mon.species} ability ${ability} | ${body}` };
}

function narrowedRoles(mon: BoardMon, stats: SpeciesStats | undefined): Array<{ name: string; data: RoleData; probability: number }> {
  if (!stats) return [];
  const rows = Object.entries(stats.roles ?? {}).map(([name, data]) => ({ name, data, probability: data.weight ?? 0 }));
  const filtered = rows.filter(role => roleMatches(mon, role.data, stats));
  const used = filtered.length > 0 ? filtered : [];
  const total = used.reduce((sum, role) => sum + Math.max(0, role.probability), 0);
  if (total <= 0) return used;
  return used
    .map(role => ({ ...role, probability: role.probability / total }))
    .sort((a, b) => b.probability - a.probability);
}

function roleMatches(mon: BoardMon, role: RoleData, stats: SpeciesStats): boolean {
  for (const move of mon.knownMoves) {
    if ((role.moves?.[move] ?? role.moves?.[Dex.moves.get(move).id] ?? 0) <= 0 && !hasMove(role, move)) return false;
  }
  if (mon.abilityKnown && mon.ability && (stats.abilities?.[mon.ability] ?? 0) <= 0 && !hasKey(stats.abilities, mon.ability)) {
    return false;
  }
  if (mon.itemKnown && mon.item && !hasKey(role.items, mon.item)) return false;
  if (mon.teraKnown && mon.teraType && !hasKey(role.teraTypes, mon.teraType)) return false;
  return true;
}

function hasMove(role: RoleData, move: string): boolean {
  const id = Dex.moves.get(move).id;
  return Object.keys(role.moves ?? {}).some(name => Dex.moves.get(name).id === id && (role.moves?.[name] ?? 0) > 0);
}

function hasKey(weights: Record<string, number> | undefined, name: string): boolean {
  if (!weights) return false;
  const id = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return Object.entries(weights).some(([key, weight]) => weight > 0 && key.toLowerCase().replace(/[^a-z0-9]/g, '') === id);
}

function topRole(mon: BoardMon, stats: SpeciesStats | undefined): { name: string; data: RoleData } | null {
  const roles = narrowedRoles(mon, stats);
  return roles.length > 0 ? roles[0] : null;
}

function spreadFor(mon: BoardMon, stats: SpeciesStats | undefined): { nature: string; evs: StatSpread; source: string } {
  if (mon.evs && mon.nature) return { nature: mon.nature, evs: mon.evs, source: 'known' };
  const role = topRole(mon, stats);
  const evs = readEvs(role?.data.evs);
  const nature = role?.data.nature ?? ASSUMED_NATURE;
  return { nature, evs: evs.values, source: evs.fromPool ? `role:${role?.name}` : 'assumed-85-Serious' };
}

function readEvs(raw: Record<string, number> | undefined): { values: StatSpread; fromPool: boolean } {
  if (!raw) return { values: { ...ASSUMED_EVS }, fromPool: false };
  const values = { ...ASSUMED_EVS };
  let fromPool = false;
  for (const key of STAT_KEYS) {
    if (typeof raw[key] === 'number') {
      values[key] = raw[key];
      fromPool = true;
    }
  }
  return { values, fromPool };
}

function toCalc(mon: BoardMon, pools: RandbatsStats, terastallize: boolean): Pokemon {
  const stats = poolFor(mon, pools);
  const ability = mon.abilityKnown ? mon.ability : topWeight(stats?.abilities);
  const item = mon.itemKnown ? mon.item : topWeight(topRole(mon, stats)?.data.items);
  const spread = spreadFor(mon, stats);
  const options: Record<string, unknown> = {
    level: mon.level || stats?.level || 80,
    ability: ability && ability !== 'unknown' ? ability : undefined,
    item: item && item !== 'none' ? item : undefined,
    nature: spread.nature,
    evs: spread.evs,
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    boosts: {
      atk: mon.boosts.atk ?? 0,
      def: mon.boosts.def ?? 0,
      spa: mon.boosts.spa ?? 0,
      spd: mon.boosts.spd ?? 0,
      spe: mon.boosts.spe ?? 0,
    },
    status: mapStatus(mon.status),
    teraType: terastallize ? mon.teraType : undefined,
  };
  return new Pokemon(9, battleSpecies(mon.species), options as never);
}

function calcField(board: BoardInput): Field {
  return new Field({
    weather: mapWeather(board.field.weather),
    terrain: mapTerrain(board.field.terrain),
  });
}

function mapWeather(weather: string | undefined): 'Sun' | 'Rain' | 'Sand' | 'Snow' | undefined {
  if (!weather) return undefined;
  const table: Record<string, 'Sun' | 'Rain' | 'Sand' | 'Snow'> = {
    sun: 'Sun', sunnyday: 'Sun', rain: 'Rain', raindance: 'Rain', sand: 'Sand', sandstorm: 'Sand', snow: 'Snow', hail: 'Snow',
  };
  return table[weather.toLowerCase().replace(/[^a-z]/g, '')];
}

function mapTerrain(terrain: string | undefined): 'Electric' | 'Grassy' | 'Psychic' | 'Misty' | undefined {
  if (!terrain) return undefined;
  const table: Record<string, 'Electric' | 'Grassy' | 'Psychic' | 'Misty'> = {
    electric: 'Electric', electricterrain: 'Electric', grassy: 'Grassy', grassyterrain: 'Grassy',
    psychic: 'Psychic', psychicterrain: 'Psychic', misty: 'Misty', mistyterrain: 'Misty',
  };
  return table[terrain.toLowerCase().replace(/[^a-z]/g, '')];
}

function mapStatus(status: string | undefined): 'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz' | '' {
  if (!status) return '';
  const table: Record<string, 'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz'> = {
    brn: 'brn', par: 'par', psn: 'psn', tox: 'tox', slp: 'slp', frz: 'frz',
  };
  return table[status.toLowerCase()] ?? '';
}

function alive(team: BoardMon[]): BoardMon[] {
  return team.filter(mon => !mon.fainted && mon.species && mon.species !== 'Unknown');
}

function weightsText(weights: Record<string, number> | undefined, limit = 4): string {
  if (!weights) return 'none';
  const parts = Object.entries(weights)
    .filter(([, weight]) => weight > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, weight]) => `${name}:${fmtWeight(weight)}`);
  return parts.length ? parts.join(',') : 'none';
}

function fmtWeight(weight: number): string {
  if (weight <= 1) return `${Math.round(weight * 100)}%`;
  return String(Math.round(weight));
}

function topWeight(weights: Record<string, number> | undefined): string | undefined {
  if (!weights) return undefined;
  const entries = Object.entries(weights).filter(([, weight]) => weight > 0);
  if (entries.length === 0) return undefined;
  return entries.sort((a, b) => b[1] - a[1])[0][0];
}

/** Belief-shaped helper for callers that still have a PokemonBelief. */
export function beliefMoves(mon: PokemonBelief | undefined): string[] {
  if (!mon) return [];
  return [...(mon.revealedMoves ?? [])];
}
