import { Dex } from '@pkmn/dex';
import { Move, Pokemon, Field, calculate, calcStat } from '@smogon/calc';
import type { GameState, PokemonBelief, RandbatsStats, RoleData, SpeciesStats } from '../types/index.js';
import type { AdvisorCandidate } from './types.js';
import { battleSpecies } from '../engine/exact/species.js';
import { actionId, capEvaluationState } from './state-summary.js';

export interface BattleFacts {
  text: string;
  criteria: Record<string, string>;
}

const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
const ASSUMED_EVS = { hp: 84, atk: 84, def: 84, spa: 84, spd: 84, spe: 84 };
const ASSUMED_NATURE = 'Serious';

/**
 * Facts for Jev and the loss reviewer. Every number comes from the dex,
 * @smogon/calc, or the randbats role pool passed in.
 */
export function buildBattleFacts(
  state: GameState,
  candidates: AdvisorCandidate[],
  pools: RandbatsStats = {}
): BattleFacts {
  const mine = state.myTeam[state.myActive];
  const opp = state.opponentTeam[state.opponentActive];
  const field = calcField(state);
  const myMon = mine ? makeCalcMon(mine, pools, false) : undefined;
  const oppMon = opp ? makeCalcMon(opp, pools, false) : undefined;

  const lines: string[] = [
    'FACTS from @pkmn/dex, @smogon/calc, and the randbats role pool. Do not add type matchups from memory.',
    `turn=${state.turn} player=${state.playerId ?? 'unknown'}`,
    fieldLine(state),
    mine ? monLine('MY ACTIVE', mine, pools, state.myTeraUsed) : 'MY ACTIVE: none',
    opp ? monLine('OPP ACTIVE', opp, pools, state.opponentTeraUsed) : 'OPP ACTIVE: none',
    speedLine(mine, opp, pools, state.field.trickRoom),
    benchLine('MY BENCH', state.myTeam, state.myActive, pools),
    benchLine('OPP BENCH', state.opponentTeam, state.opponentActive, pools),
  ];

  if (opp && oppMon) {
    lines.push(likelyMovesLine(state, opp, pools, field));
  } else {
    lines.push('OPP LIKELY MOVES: none');
  }

  lines.push('CANDIDATES');
  const criteria: Record<string, string> = {};
  for (const candidate of candidates) {
    const summary = candidateSummary(state, candidate, pools, field, myMon, oppMon);
    criteria[candidate.id] = summary;
    lines.push(`${candidate.id} ${summary}`);
  }

  return { text: capEvaluationState(lines.join('\n')), criteria };
}

export function reviveGameState(raw: string): GameState | undefined {
  try {
    const parsed = JSON.parse(raw) as GameState;
    if (!parsed || !Array.isArray(parsed.myTeam) || !Array.isArray(parsed.opponentTeam)) return undefined;
    for (const mon of [...parsed.myTeam, ...parsed.opponentTeam]) reviveMon(mon);
    return parsed;
  } catch {
    return undefined;
  }
}

function reviveMon(mon: PokemonBelief): void {
  const sets = mon.possibleSets as unknown;
  if (!(sets instanceof Map)) {
    mon.possibleSets = sets && typeof sets === 'object'
      ? new Map(Object.entries(sets as Record<string, number>))
      : new Map();
  }
  const revealed = mon.revealedMoves as unknown;
  if (revealed instanceof Set) return;
  mon.revealedMoves = Array.isArray(revealed) ? new Set(revealed as string[]) : new Set();
}

export function effectiveSpeed(
  base: number,
  level: number,
  ev: number,
  nature: string,
  item: string | undefined,
  stage: number
): number {
  let speed = calcStat(9, 'spe', base, 31, ev, level, nature);
  if (item === 'Choice Scarf') speed = Math.floor(speed * 1.5);
  return applyStage(speed, stage);
}

function candidateSummary(
  state: GameState,
  candidate: AdvisorCandidate,
  pools: RandbatsStats,
  field: Field,
  myMon: Pokemon | undefined,
  oppMon: Pokemon | undefined
): string {
  const search = `search=${formatScore(candidate.searchScore)}`;
  if (candidate.action.type === 'switch') {
    const incoming = state.myTeam[candidate.action.switchIndex];
    const name = incoming?.species ?? `slot ${candidate.action.switchIndex}`;
    const hp = incoming ? hpText(incoming) : 'hp=unknown';
    const types = incoming ? typeText(incoming.species) : 'types=unknown';
    const incomingRolls = oppMon && incoming
      ? likelyMoveRollsOnto(state.opponentTeam[state.opponentActive], pools, makeCalcMon(incoming, pools, false), field)
      : 'no opponent damage roll';
    return `switch ${name} ${types} ${hp} ${search} ${actionId(candidate.action)} incoming=${incomingRolls}`;
  }

  const actor = state.myTeam[state.myActive];
  const moveName = actor?.moves?.[candidate.action.moveIndex - 1];
  if (!moveName) {
    return `move slot ${candidate.action.moveIndex} name=unknown no damage roll ${search} ${actionId(candidate.action)}`;
  }
  if (!myMon || !oppMon) {
    const info = moveInfo(moveName);
    return `${moveName} ${info} defender=unknown no damage roll ${search}`;
  }
  const attacker = candidate.action.terastallize && actor?.revealedTeraType
    ? makeCalcMon(actor, pools, true)
    : myMon;
  const roll = damageRoll(attacker, oppMon, moveName, field);
  const tera = candidate.action.terastallize ? ' tera=yes' : '';
  return `${moveName}${tera} ${roll} ${search} ${actionId(candidate.action)}`;
}

function likelyMovesLine(state: GameState, opp: PokemonBelief, pools: RandbatsStats, field: Field): string {
  const moves = likelyMoveNames(opp, poolFor(opp.species, pools));
  if (moves.length === 0) return 'OPP LIKELY MOVES: role pool has none';
  const attacker = makeCalcMon(opp, pools, false);
  const targets = [state.myTeam[state.myActive], ...state.myTeam.filter((_, index) => index !== state.myActive)]
    .filter((mon): mon is PokemonBelief => !!mon);
  const parts = moves.map(moveName => {
    const onto = targets.map(target => {
      const roll = damageRoll(attacker, makeCalcMon(target, pools, false), moveName, field);
      return `${target.species}[${hpText(target)}] ${roll}`;
    });
    return `${moveName}: ${onto.join(' || ')}`;
  });
  return `OPP LIKELY MOVES\n${parts.join('\n')}`;
}

function likelyMoveRollsOnto(
  opp: PokemonBelief | undefined,
  pools: RandbatsStats,
  defender: Pokemon,
  field: Field
): string {
  if (!opp) return 'none';
  const attacker = makeCalcMon(opp, pools, false);
  const moves = likelyMoveNames(opp, poolFor(opp.species, pools)).slice(0, 4);
  if (moves.length === 0) return 'none';
  return moves.map(moveName => `${moveName} ${damageRoll(attacker, defender, moveName, field)}`).join('; ');
}

function likelyMoveNames(mon: PokemonBelief, stats: SpeciesStats | undefined): string[] {
  const role = topRole(mon, stats);
  const table = role?.data.moves ?? {};
  return Object.entries(table)
    .filter(([, weight]) => weight > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name]) => name);
}

function damageRoll(attacker: Pokemon, defender: Pokemon, moveName: string, field: Field): string {
  const info = moveInfo(moveName);
  if (info.includes('unknown to dex')) return info;
  const move = Dex.moves.get(moveName);
  if (move.category === 'Status') return `${info} no damage roll`;
  try {
    const result = calculate(9, attacker, defender, new Move(9, moveName), field);
    const rolls = flattenDamage(result.damage);
    if (rolls.length === 0 || rolls.every(roll => roll === 0)) {
      return `${info} damage=0 immune or no effect expectedAfterAccuracy=0`;
    }
    const [min, max] = result.range();
    const maxHp = defender.maxHP();
    const pct = (value: number) => (Math.round((value / maxHp) * 1000) / 10).toFixed(1);
    const accuracy = move.accuracy === true ? 100 : Number(move.accuracy);
    const expected = Math.round(((min + max) / 2) * (accuracy / 100));
    let ko = 'ko=n/a';
    try {
      ko = `ko=${result.kochance().text}`;
    } catch {
      ko = 'ko=n/a';
    }
    return `${info} damage=${min}-${max} (${pct(min)}-${pct(max)}%) ${ko} expectedAfterAccuracy=${expected}`;
  } catch {
    return `${info} damage=0 immune or no effect expectedAfterAccuracy=0`;
  }
}

function moveInfo(moveName: string): string {
  const move = Dex.moves.get(moveName);
  if (!move.exists) return `${moveName} unknown to dex`;
  const accuracy = move.accuracy === true ? 100 : move.accuracy;
  return `type=${move.type} cat=${move.category} bp=${move.basePower} acc=${accuracy} pri=${move.priority}`;
}

function monLine(label: string, mon: PokemonBelief, pools: RandbatsStats, teraUsed: boolean): string {
  const assumption = assumptionText(mon, pools);
  return [
    label,
    mon.species,
    typeText(mon.species),
    `tera=${mon.revealedTeraType ?? 'unknown'} teraUsed=${teraUsed}`,
    assumption.ability,
    assumption.item,
    `level=${mon.level}`,
    hpText(mon),
    boostText(mon),
    `status=${mon.status ?? 'none'}`,
    assumption.spread,
    mon.moves?.length ? `moveSlots=${mon.moves.map((move, index) => `${index + 1}:${move}`).join(',')}` : 'moveSlots=unknown',
  ].join(' ');
}

function benchLine(label: string, team: PokemonBelief[], active: number, pools: RandbatsStats): string {
  const bench = team.filter((_, index) => index !== active);
  if (bench.length === 0) return `${label}: none`;
  return `${label}\n${bench.map(mon => `${mon.species} ${typeText(mon.species)} ${hpText(mon)} ${assumptionText(mon, pools).ability}`).join('\n')}`;
}

function speedLine(
  mine: PokemonBelief | undefined,
  opp: PokemonBelief | undefined,
  pools: RandbatsStats,
  trickRoom: boolean
): string {
  if (!mine || !opp) return 'SPEED: unknown';
  const mineSpeed = speedOf(mine, pools);
  const oppSpeed = speedOf(opp, pools);
  let order: string;
  if (mineSpeed.value === oppSpeed.value) order = 'speed tie before priority';
  else if (trickRoom) order = mineSpeed.value < oppSpeed.value ? `${mine.species} moves first under trick room` : `${opp.species} moves first under trick room`;
  else order = mineSpeed.value > oppSpeed.value ? `${mine.species} moves first` : `${opp.species} moves first`;
  return `SPEED ${mine.species}=${mineSpeed.detail} ${opp.species}=${oppSpeed.detail} order=${order}. Priority from the dex is applied per move and is not a type matchup.`;
}

function speedOf(mon: PokemonBelief, pools: RandbatsStats): { value: number; detail: string } {
  const species = Dex.species.get(mon.species);
  const base = species.exists ? species.baseStats.spe : 0;
  const spread = spreadFor(mon, poolFor(mon.species, pools));
  const item = itemFor(mon, poolFor(mon.species, pools));
  const stage = mon.boosts?.spe ?? 0;
  const value = species.exists ? effectiveSpeed(base, mon.level, spread.evs.spe, spread.nature, item.name, stage) : 0;
  return {
    value,
    detail: `${value} (base=${base} nature=${spread.nature} speEV=${spread.evs.spe} item=${item.name} scarf=${item.name === 'Choice Scarf'} speBoost=${stage} spreadSource=${spread.source})`,
  };
}

function typeText(species: string): string {
  const data = Dex.species.get(species);
  if (!data.exists) return 'types=unknown-to-dex';
  return `types=${data.types.join('/')}`;
}

function hpText(mon: PokemonBelief): string {
  if (mon.currentHp == null || !mon.maxHp) return 'hp=unknown';
  const pct = Math.round((mon.currentHp / mon.maxHp) * 1000) / 10;
  return `hp=${pct}% (${mon.currentHp}/${mon.maxHp})`;
}

function boostText(mon: PokemonBelief): string {
  const boosts = mon.boosts;
  if (!boosts) return 'boosts=none';
  return `boosts=atk${boosts.atk}/def${boosts.def}/spa${boosts.spa}/spd${boosts.spd}/spe${boosts.spe}`;
}

function fieldLine(state: GameState): string {
  const screens = state.field.screens;
  return [
    'FIELD',
    `weather=${state.field.weather ?? 'none'}`,
    `terrain=${state.field.terrain ?? 'none'}`,
    `trickRoom=${state.field.trickRoom}`,
    `screens reflect=${screens.reflect ?? 0} lightScreen=${screens.lightScreen ?? 0}`,
    `hazards mine rocks=${state.hazards.my.stealthRock} spikes=${state.hazards.my.spikes} toxicSpikes=${state.hazards.my.toxicSpikes}`,
    `hazards opp rocks=${state.hazards.opponent.stealthRock} spikes=${state.hazards.opponent.spikes} toxicSpikes=${state.hazards.opponent.toxicSpikes}`,
  ].join(' ');
}

function assumptionText(mon: PokemonBelief, pools: RandbatsStats): { ability: string; item: string; spread: string } {
  const stats = poolFor(mon.species, pools);
  const ability = abilityFor(mon, stats);
  const item = itemFor(mon, stats);
  const spread = spreadFor(mon, stats);
  return {
    ability: ability.known ? `ability=${ability.name} (known)` : `ability=${ability.name} (assumed from role pool: ${ability.choices})`,
    item: item.known ? `item=${item.name} (known)` : `item=${item.name} (assumed from role pool: ${item.choices})`,
    spread: `nature=${spread.nature} evs=${STAT_KEYS.map(key => spread.evs[key]).join('/')} spreadSource=${spread.source}`,
  };
}

function abilityFor(mon: PokemonBelief, stats: SpeciesStats | undefined): { name: string; known: boolean; choices: string } {
  const choices = formatWeights(stats?.abilities);
  if (mon.revealedAbility) return { name: mon.revealedAbility, known: true, choices };
  const top = topWeight(stats?.abilities);
  return { name: top ?? 'unknown', known: false, choices: choices || 'none' };
}

function itemFor(mon: PokemonBelief, stats: SpeciesStats | undefined): { name: string; known: boolean; choices: string } {
  const role = topRole(mon, stats);
  const choices = formatWeights(role?.data.items ?? stats?.items);
  if (mon.revealedItem) return { name: mon.revealedItem, known: true, choices };
  const top = topWeight(role?.data.items) ?? topWeight(stats?.items);
  return { name: top ?? 'none', known: false, choices: choices || 'none' };
}

function spreadFor(mon: PokemonBelief, stats: SpeciesStats | undefined): { nature: string; evs: Record<(typeof STAT_KEYS)[number], number>; source: string } {
  const role = topRole(mon, stats);
  const evs = readEvs(role?.data.evs);
  const nature = role?.data.nature ?? ASSUMED_NATURE;
  const source = role?.data.nature || evs.fromPool ? `role:${role?.name ?? 'pool'}` : 'assumed-84-Serious';
  return { nature, evs: evs.values, source };
}

function readEvs(raw: Record<string, number> | undefined): { values: Record<(typeof STAT_KEYS)[number], number>; fromPool: boolean } {
  if (raw && STAT_KEYS.every(key => typeof raw[key] === 'number')) {
    return {
      values: {
        hp: raw.hp,
        atk: raw.atk,
        def: raw.def,
        spa: raw.spa,
        spd: raw.spd,
        spe: raw.spe,
      },
      fromPool: true,
    };
  }
  return { values: { ...ASSUMED_EVS }, fromPool: false };
}

function topRole(mon: PokemonBelief, stats: SpeciesStats | undefined): { name: string; data: RoleData } | null {
  if (!stats) return null;
  const roles = Object.entries(stats.roles ?? {});
  if (roles.length === 0) return null;
  if (mon.possibleSets && mon.possibleSets.size > 0) {
    let best: { name: string; data: RoleData } | null = null;
    let bestP = -1;
    for (const [name, probability] of mon.possibleSets) {
      const data = stats.roles[name];
      if (!data) continue;
      if (probability > bestP) {
        best = { name, data };
        bestP = probability;
      }
    }
    if (best) return best;
  }
  return roles
    .map(([name, data]) => ({ name, data }))
    .sort((a, b) => (b.data.weight ?? 0) - (a.data.weight ?? 0))[0];
}

function poolFor(species: string, pools: RandbatsStats): SpeciesStats | undefined {
  return pools[species] ?? pools[battleSpecies(species)];
}

function makeCalcMon(mon: PokemonBelief, pools: RandbatsStats, terastallize: boolean): Pokemon {
  const stats = poolFor(mon.species, pools);
  const ability = abilityFor(mon, stats).name;
  const item = itemFor(mon, stats).name;
  const spread = spreadFor(mon, stats);
  const options: Record<string, unknown> = {
    level: mon.level,
    ability: ability === 'unknown' ? undefined : ability,
    item: item === 'none' ? undefined : item,
    nature: spread.nature,
    evs: spread.evs,
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    boosts: {
      hp: 0,
      atk: mon.boosts?.atk ?? 0,
      def: mon.boosts?.def ?? 0,
      spa: mon.boosts?.spa ?? 0,
      spd: mon.boosts?.spd ?? 0,
      spe: mon.boosts?.spe ?? 0,
    },
    status: mapStatus(mon.status),
    teraType: terastallize ? mon.revealedTeraType : undefined,
  };
  const draft = new Pokemon(9, battleSpecies(mon.species), options as never);
  if (mon.currentHp != null && mon.maxHp) {
    const pct = mon.currentHp / mon.maxHp;
    options.curHP = Math.max(1, Math.round(draft.maxHP() * pct));
    return new Pokemon(9, battleSpecies(mon.species), options as never);
  }
  return draft;
}

function calcField(state: GameState): Field {
  return new Field({
    weather: mapWeather(state.field.weather),
    terrain: mapTerrain(state.field.terrain),
  });
}

function mapWeather(weather: string | undefined): 'Sun' | 'Rain' | 'Sand' | 'Snow' | 'Harsh Sunshine' | 'Heavy Rain' | 'Strong Winds' | undefined {
  if (!weather) return undefined;
  const table: Record<string, 'Sun' | 'Rain' | 'Sand' | 'Snow' | 'Harsh Sunshine' | 'Heavy Rain' | 'Strong Winds'> = {
    sun: 'Sun',
    sunnyday: 'Sun',
    rain: 'Rain',
    raindance: 'Rain',
    sand: 'Sand',
    sandstorm: 'Sand',
    snow: 'Snow',
    harshsunshine: 'Harsh Sunshine',
    heavyrain: 'Heavy Rain',
    strongwinds: 'Strong Winds',
  };
  return table[weather.toLowerCase().replace(/[^a-z]/g, '')];
}

function mapTerrain(terrain: string | undefined): 'Electric' | 'Grassy' | 'Psychic' | 'Misty' | undefined {
  if (!terrain) return undefined;
  const table: Record<string, 'Electric' | 'Grassy' | 'Psychic' | 'Misty'> = {
    electric: 'Electric',
    electricterrain: 'Electric',
    grassy: 'Grassy',
    grassyterrain: 'Grassy',
    psychic: 'Psychic',
    psychicterrain: 'Psychic',
    misty: 'Misty',
    mistyterrain: 'Misty',
  };
  return table[terrain.toLowerCase().replace(/[^a-z]/g, '')];
}

function mapStatus(status: string | undefined): 'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz' | '' {
  if (!status) return '';
  const table: Record<string, 'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz'> = {
    brn: 'brn',
    burn: 'brn',
    par: 'par',
    paralysis: 'par',
    psn: 'psn',
    poison: 'psn',
    tox: 'tox',
    toxic: 'tox',
    slp: 'slp',
    sleep: 'slp',
    frz: 'frz',
    freeze: 'frz',
  };
  return table[status.toLowerCase()] ?? '';
}

function applyStage(stat: number, stage: number): number {
  if (stage === 0) return stat;
  const positive = stage > 0;
  const num = positive ? 2 + stage : 2;
  const den = positive ? 2 : 2 - stage;
  return Math.floor((stat * num) / den);
}

function flattenDamage(damage: unknown): number[] {
  if (typeof damage === 'number') return [damage];
  if (!Array.isArray(damage)) return [];
  const flat: number[] = [];
  for (const entry of damage) {
    if (typeof entry === 'number') flat.push(entry);
    else if (Array.isArray(entry)) flat.push(...entry.filter((value): value is number => typeof value === 'number'));
  }
  return flat;
}

function topWeight(weights: Record<string, number> | undefined): string | undefined {
  if (!weights) return undefined;
  const entries = Object.entries(weights);
  if (entries.length === 0) return undefined;
  return entries.sort((a, b) => b[1] - a[1])[0][0];
}

function formatWeights(weights: Record<string, number> | undefined): string {
  if (!weights) return '';
  return Object.entries(weights).sort((a, b) => b[1] - a[1]).map(([name, weight]) => `${name}:${weight}`).join(',');
}

function formatScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(2);
}
