import { Battle, Teams } from '@pkmn/sim';
import fs from 'fs';
import path from 'path';
import { SideId, ensureGenerators } from './battle-utils.js';
import { hazardFraction, marginAgainst, publicSpeed } from './matchup.js';

/**
 * Team-eval features. Locked before held-out is scored.
 * No species indicators. Matchup is the mean 1v1 margin over remaining
 * pokemon (Sarantinos 2022). Hazard pressure is entry chip on pokemon
 * that are not holding Heavy-Duty Boots.
 */
export const TEAM_EVAL_FEATURES = [
  'bias',
  'hpDifference',
  'faintDifference',
  'matchup',
  'speedControl',
  'hazardPressure',
  'status',
  'boosts',
  'tera',
  'healthyChecks',
] as const;

export type TeamFeatureName = (typeof TEAM_EVAL_FEATURES)[number];

export const MIN_RANDBATS_SPECIES = 500;

const STATUS_COST: Record<string, number> = {
  slp: 1,
  frz: 1,
  brn: 0.7,
  tox: 0.6,
  psn: 0.45,
  par: 0.35,
};

const marginMemo = new Map<string, number>();

export function randbatsSpeciesCount(): number {
  ensureGenerators();
  const gen = Teams.getGenerator('gen9randombattle') as { randomSets?: Record<string, unknown> };
  return Object.keys(gen.randomSets || {}).length;
}

/** Species in data/gen9-stats.json, or null when that file has not been refreshed. */
export function statsFileSpeciesCount(): number | null {
  const statsPath = path.join(process.cwd(), 'data', 'gen9-stats.json');
  if (!fs.existsSync(statsPath)) return null;
  const parsed = JSON.parse(fs.readFileSync(statsPath, 'utf8')) as Record<string, unknown>;
  return Object.keys(parsed).length;
}

/**
 * Fail when the randbats pool this eval queries is under 500 species.
 * That pool is the generator's randomSets. data/gen9-stats.json is a
 * separate usage dump, and unit tests overwrite it with a one-species
 * fixture, so it is reported and not used as the gate.
 */
export function assertRandbatsSpecies(min = MIN_RANDBATS_SPECIES): number {
  const generator = randbatsSpeciesCount();
  if (generator < min) {
    throw new Error(
      `Randbats generator has ${generator} species (need >= ${min}).`,
    );
  }
  return generator;
}

export function applyStandard(raw: number[], mean: number[], std: number[]): number[] {
  return raw.map((value, index) => {
    if (index === 0) return 1;
    const scale = std[index] ?? 0;
    if (scale < 1e-8) return 0;
    return (value - (mean[index] ?? 0)) / scale;
  });
}

export function teamFeatureVector(battle: Battle, side: SideId): number[] {
  const us = battle.getSide(side);
  const them = us.foe;
  const weather = (battle.field as { weather?: { id?: string } }).weather?.id;
  const trick = Boolean((battle.field as { pseudoWeather?: { trickroom?: unknown } }).pseudoWeather?.trickroom);

  let ourHp = 0;
  let theirHp = 0;
  let ourFaints = 0;
  let theirFaints = 0;
  for (const mon of us.pokemon) {
    ourHp += hpFrac(mon);
    if (!mon || mon.fainted || mon.hp <= 0) ourFaints++;
  }
  for (const mon of them.pokemon) {
    theirHp += hpFrac(mon);
    if (!mon || mon.fainted || mon.hp <= 0) theirFaints++;
  }

  const ourAlive = us.pokemon.filter(mon => mon && !mon.fainted && mon.hp > 0);
  const theirAlive = them.pokemon.filter(mon => mon && !mon.fainted && mon.hp > 0);
  let matchup = 0;
  if (ourAlive.length && theirAlive.length) {
    let total = 0;
    let pairs = 0;
    for (const ours of ourAlive) {
      for (const foe of theirAlive) {
        total += cachedMargin(ours, foe, true, weather);
        pairs++;
      }
    }
    matchup = total / pairs;
  }

  const vector = [
    1,
    (ourHp - theirHp) / 6,
    (theirFaints - ourFaints) / 6,
    matchup,
    speedControl(ourAlive, theirAlive, trick, weather),
    meanHazard(them) - meanHazard(us),
    meanStatus(them) - meanStatus(us),
    boostScore(us.active[0]) - boostScore(them.active[0]),
    (teraLeft(us) - teraLeft(them)),
    (healthyChecks(us, them.active[0], weather) - healthyChecks(them, us.active[0], weather)) / 6,
  ];
  return vector.map(value => (Number.isFinite(value) ? value : 0));
}

export function featureRecord(battle: Battle, side: SideId): Record<TeamFeatureName, number> {
  const vector = teamFeatureVector(battle, side);
  const record = {} as Record<TeamFeatureName, number>;
  TEAM_EVAL_FEATURES.forEach((name, index) => {
    record[name] = vector[index] ?? 0;
  });
  return record;
}

function hpFrac(mon: { hp?: number; maxhp?: number; fainted?: boolean } | null | undefined): number {
  if (!mon || mon.fainted || !mon.maxhp || mon.maxhp <= 0) return 0;
  return Math.max(0, Math.min(1, mon.hp! / mon.maxhp));
}

function cachedMargin(our: any, foe: any, ownMoves: boolean, weather?: string): number {
  const key = [
    our?.species?.name, our?.level, our?.hp, our?.status, our?.item, our?.ability,
    moveKey(our), boostKey(our),
    foe?.species?.name, foe?.level, foe?.hp, foe?.status, foe?.item, foe?.ability,
    moveKey(foe), boostKey(foe),
    ownMoves ? 1 : 0, weather || '',
  ].join('|');
  const hit = marginMemo.get(key);
  if (hit !== undefined) return hit;
  let value = 0;
  try {
    value = marginAgainst(our, foe, ownMoves, weather);
  } catch {
    // Unknown forme: no matchup evidence rather than a crashed search.
    value = 0;
  }
  marginMemo.set(key, value);
  return value;
}

function moveKey(mon: any): string {
  const slots = mon?.moveSlots || [];
  return slots.map((slot: { id?: string }) => slot?.id || '').join(',');
}

function boostKey(mon: any): string {
  const b = mon?.boosts || {};
  return [b.atk || 0, b.def || 0, b.spa || 0, b.spd || 0, b.spe || 0].join(',');
}

function speedStage(stat: number, boost: number): number {
  if (boost >= 0) return stat * (2 + boost) / 2;
  return stat * 2 / (2 - boost);
}

function effectiveSpeed(mon: any, trick: boolean, weather?: string): number {
  if (!mon) return 0;
  const raw = mon.storedStats?.spe || publicSpeed(mon.species?.name || '', mon.level || 80);
  let spe = speedStage(raw, mon.boosts?.spe || 0);
  const ability = String(mon.ability || '');
  if (mon.status === 'par' && ability !== 'quickfeet') spe *= 0.5;
  if (mon.item === 'choicescarf') spe *= 1.5;
  if (ability === 'swiftswim' && weather === 'raindance') spe *= 2;
  if (ability === 'chlorophyll' && weather === 'sunnyday') spe *= 2;
  if (ability === 'sandrush' && weather === 'sandstorm') spe *= 2;
  if (ability === 'slushrush' && (weather === 'snow' || weather === 'hail')) spe *= 2;
  return trick ? -spe : spe;
}

function speedControl(ours: any[], theirs: any[], trick: boolean, weather?: string): number {
  if (!ours.length || !theirs.length) return 0;
  let wins = 0;
  let losses = 0;
  let pairs = 0;
  for (const our of ours) {
    const ourSpeed = effectiveSpeed(our, trick, weather);
    for (const foe of theirs) {
      pairs++;
      const foeSpeed = effectiveSpeed(foe, trick, weather);
      if (ourSpeed > foeSpeed) wins++;
      else if (ourSpeed < foeSpeed) losses++;
    }
  }
  return pairs ? (wins - losses) / pairs : 0;
}

/** Entry hazard chip, unless Heavy-Duty Boots negates it. */
export function bootsHazard(mon: any): number {
  if (!mon || mon.fainted || mon.hp <= 0) return 0;
  if (mon.item === 'heavydutyboots') return 0;
  let fraction = hazardFraction(mon);
  const layers = mon.side?.sideConditions?.toxicspikes?.layers || 0;
  if (layers > 0 && groundedPoisonable(mon)) fraction += layers >= 2 ? 0.12 : 0.06;
  return Math.max(0, Math.min(1, fraction));
}

function groundedPoisonable(mon: any): boolean {
  const types: string[] = mon.getTypes?.() || mon.types || [];
  if (types.includes('Poison') || types.includes('Steel') || types.includes('Flying')) return false;
  if (String(mon.ability || '') === 'levitate' || mon.item === 'airballoon') return false;
  if (mon.status) return false;
  return true;
}

function meanHazard(side: { pokemon: any[] }): number {
  const alive = side.pokemon.filter(mon => mon && !mon.fainted && mon.hp > 0);
  if (!alive.length) return 0;
  let total = 0;
  for (const mon of alive) total += bootsHazard(mon);
  return total / alive.length;
}

function meanStatus(side: { pokemon: any[] }): number {
  const alive = side.pokemon.filter(mon => mon && !mon.fainted && mon.hp > 0);
  if (!alive.length) return 0;
  let total = 0;
  for (const mon of alive) total += STATUS_COST[mon.status] || 0;
  return total / alive.length;
}

function boostScore(mon: any): number {
  if (!mon?.boosts) return 0;
  const b = mon.boosts;
  return ((b.atk || 0) + (b.def || 0) + (b.spa || 0) + (b.spd || 0) + (b.spe || 0)) / 6;
}

function teraLeft(side: { pokemon: Array<{ terastallized?: string | boolean }> }): number {
  return side.pokemon.some(mon => mon && mon.terastallized) ? 0 : 1;
}

function healthy(mon: any): boolean {
  if (!mon || mon.fainted || mon.hp <= 0 || mon.status) return false;
  return hpFrac(mon) >= 0.5;
}

function healthyChecks(side: { pokemon: any[] }, threat: any, weather?: string): number {
  if (!threat || threat.fainted) return 0;
  let checks = 0;
  for (const mon of side.pokemon) {
    if (!healthy(mon)) continue;
    if (cachedMargin(mon, threat, true, weather) > 0) checks++;
  }
  return checks;
}
