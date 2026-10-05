import { Battle } from '@pkmn/sim';
import { SideId, hpEval } from './battle-utils.js';
import {
  hazardFraction,
  marginAgainst,
  priorSpecies,
  speciesLevel,
  synthThreat,
} from './matchup.js';

/**
 * Score both full teams. Terminal wins stay inside hpEval (±1000) and
 * these terms are a few points, so a finished game still outranks a lead.
 * Unrevealed opponent mons contribute a randbats prior, not their hidden set.
 *
 * Scales are in HP-eval points (one faint is 2). They are not fit to a
 * named position.
 */
export function teamEval(battle: Battle, side: SideId): number {
  const base = hpEval(battle, side);
  if (battle.ended && battle.winner) return base;

  const us = battle.getSide(side);
  const them = us.foe;
  const foe = them.active[0];
  const active = us.active[0];
  const weather = (battle.field as any).weather?.id as string | undefined;
  if (!active || !foe) return base;

  const activeMargin = marginAgainst(active, foe, true, weather);
  let bestBench = activeMargin;
  for (const mon of us.pokemon) {
    if (!mon || mon.fainted || mon.isActive) continue;
    const margin = marginAgainst(mon, foe, true, weather) - hazardFraction(mon);
    if (margin > bestBench) bestBench = margin;
  }

  let theirBest = -2;
  let unrevealed = 0;
  for (const mon of them.pokemon) {
    if (!mon || mon.fainted) continue;
    if ((mon.previouslySwitchedIn || 0) <= 0 && !mon.isActive) {
      unrevealed++;
      continue;
    }
    if (mon.isActive) continue;
    const margin = marginAgainst(mon, active, false, weather);
    if (margin > theirBest) theirBest = margin;
  }

  const weTera = Boolean(active.canTerastallize);
  const theyTera = Boolean(foe.canTerastallize);
  const prior = unrevealed > 0 ? priorThreat(active.species.name, active.level) : 0;

  return base
    + 1.5 * activeMargin
    + 0.5 * (bestBench - activeMargin)
    + (publicOutspeeds(active, foe) ? 0.4 : -0.4)
    + (weTera ? 0.3 : 0)
    - (theyTera ? 0.3 : 0)
    - 0.15 * unrevealed * prior
    - (theirBest > 0 ? 0.25 * theirBest : 0);
}

function publicOutspeeds(our: any, foe: any): boolean {
  const ourSpeed = (our.species.baseStats?.spe || 0) * (our.level || 80);
  const foeSpeed = (foe.species.baseStats?.spe || 0) * (foe.level || 80);
  return ourSpeed > foeSpeed;
}

const priorCache = new Map<string, number>();

function priorThreat(species: string, level: number): number {
  const key = `${species}|${level}`;
  const cached = priorCache.get(key);
  if (cached !== undefined) return cached;
  const foes = priorSpecies(24);
  if (foes.length === 0) return 0;
  let total = 0;
  for (const foeName of foes) {
    total += synthThreat(species, level, foeName, speciesLevel(foeName));
  }
  const mean = total / foes.length;
  priorCache.set(key, mean);
  return mean;
}
