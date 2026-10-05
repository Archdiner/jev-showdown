import { Battle } from '@pkmn/sim';
import { SideId, cloneFromSnapshot, otherSide, playChoices, snapshot } from '../engine/exact/battle-utils.js';
import { ExactConfig, modalReply, reseed } from '../engine/exact/search.js';
import { toID } from './ids.js';

export const TURN_FORECAST_SCHEMA = 'jev.turn-forecast.v1' as const;

export type Actor = 'us' | 'foe';

/**
 * What one search line assumed would happen after our choice.
 * HP figures are fractions of max HP. Damage is the drop in that fraction
 * (negative when the mon healed). `samples` is how many RNG draws were averaged.
 * The foe action is the model's modal reply, not a draw from the log.
 */
export interface TurnForecast {
  schema: typeof TURN_FORECAST_SCHEMA;
  ourChoice: string;
  foeChoice: string | null;
  ourAction: string | null;
  foeAction: string | null;
  foeModel: ExactConfig['opponentModel'] | 'none';
  ourSpecies: string | null;
  foeSpecies: string | null;
  ourHpBefore: number | null;
  foeHpBefore: number | null;
  ourHpAfter: number | null;
  foeHpAfter: number | null;
  damageDealt: number | null;
  damageTaken: number | null;
  ourKo: boolean | null;
  foeKo: boolean | null;
  firstActor: Actor | null;
  stepped: boolean;
  samples: number;
}

export function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function hpFraction(hp: number, maxhp: number, fainted?: boolean): number | null {
  if (!(maxhp > 0) || !Number.isFinite(hp)) return null;
  if (fainted || hp <= 0) return 0;
  return hp / maxhp;
}

/** `208/262`, `80/100 par`, `0 fnt`. */
export function hpFractionText(raw: string | undefined | null): number | null {
  if (!raw) return null;
  if (/\bfnt\b/.test(raw)) return 0;
  const match = /(\d+)\/(\d+)/.exec(raw);
  if (!match) return null;
  return hpFraction(Number(match[1]), Number(match[2]));
}

function fractionOf(mon: { hp: number; maxhp: number; fainted?: boolean } | null | undefined): number | null {
  if (!mon) return null;
  return hpFraction(mon.hp, mon.maxhp, mon.fainted);
}

function choiceAction(side: { active: any[]; pokemon: any[] }, choice: string | null): string | null {
  if (!choice) return null;
  const move = /^move\s+(\d+)/.exec(choice);
  if (move) {
    const slot = side.active[0]?.moveSlots?.[Number(move[1]) - 1];
    const id = slot?.id || slot?.move;
    return id ? toID(String(id)) : null;
  }
  const swapped = /^switch\s+(\d+)/.exec(choice);
  if (swapped) {
    const mon = side.pokemon[Number(swapped[1]) - 1];
    const name = mon?.species?.name || (typeof mon?.species === 'string' ? mon.species : '');
    return name ? `switch:${toID(String(name))}` : null;
  }
  return null;
}

function simChoice(choice: string): string {
  return choice.replace(/\s+terastallize\b/i, '').trim();
}

function speciesName(mon: any): string | null {
  const name = mon?.species?.name || (typeof mon?.species === 'string' ? mon.species : '');
  return name ? String(name) : null;
}

function firstActor(lines: string[], ourSide: SideId): Actor | null {
  for (const line of lines) {
    if (!line.startsWith('|move|') && !line.startsWith('|switch|') && !line.startsWith('|drag|')) continue;
    const ident = line.split('|')[2] || '';
    if (ident.startsWith(ourSide)) return 'us';
    if (ident.startsWith('p1') || ident.startsWith('p2')) return 'foe';
  }
  return null;
}

interface Draw {
  ourHpAfter: number | null;
  foeHpAfter: number | null;
  ourKo: boolean;
  foeKo: boolean;
  firstActor: Actor | null;
}

/**
 * One extra rollout of the chosen line, after the search has already picked.
 * Averaging `config.samples` draws (capped at 8) matches the champion's expectation.
 * The input battle is not modified. Returns null only when the read itself throws.
 */
export function forecastLine(
  battle: Battle,
  sideId: SideId,
  myChoice: string,
  config: ExactConfig,
): TurnForecast | null {
  try {
    const me = battle.getSide(sideId);
    const foe = me.foe;
    const ourMon = me.active[0];
    const foeMon = foe.active[0];
    const ourIndex = ourMon ? me.pokemon.indexOf(ourMon) : -1;
    const foeIndex = foeMon ? foe.pokemon.indexOf(foeMon) : -1;
    const ourHpBefore = fractionOf(ourMon);
    const foeHpBefore = fractionOf(foeMon);
    const snap = snapshot(battle);
    const reply = modalReply(battle, sideId, config);
    const played = simChoice(myChoice);
    const draws = Math.min(8, Math.max(1, config.samples ?? 1));
    const samples: Draw[] = [];
    for (let sample = 0; sample < draws; sample++) {
      try {
        const next = cloneFromSnapshot(snap);
        reseed(next, sample);
        const mark = next.log.length;
        if (!playChoices(next, sideId, played, reply || undefined)) continue;
        const ourAfterMon = ourIndex >= 0 ? next.getSide(sideId).pokemon[ourIndex] : null;
        const foeAfterMon = foeIndex >= 0 ? next.getSide(otherSide(sideId)).pokemon[foeIndex] : null;
        const ourHpAfter = fractionOf(ourAfterMon);
        const foeHpAfter = fractionOf(foeAfterMon);
        samples.push({
          ourHpAfter,
          foeHpAfter,
          ourKo: ourHpBefore !== null && ourHpBefore > 0 && ourHpAfter === 0,
          foeKo: foeHpBefore !== null && foeHpBefore > 0 && foeHpAfter === 0,
          firstActor: firstActor(next.log.slice(mark), sideId),
        });
      } catch {
        // One bad draw does not drop the rest.
      }
    }
    const n = samples.length;
    const mean = (pick: (draw: Draw) => number | null): number | null => {
      const values = samples.map(pick).filter((value): value is number => value !== null);
      if (values.length === 0) return null;
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    };
    const ourHpAfter = mean(draw => draw.ourHpAfter);
    const foeHpAfter = mean(draw => draw.foeHpAfter);
    const ourKoN = samples.filter(draw => draw.ourKo).length;
    const foeKoN = samples.filter(draw => draw.foeKo).length;
    const usFirst = samples.filter(draw => draw.firstActor === 'us').length;
    const foeFirst = samples.filter(draw => draw.firstActor === 'foe').length;
    let actor: Actor | null = null;
    if (usFirst > foeFirst) actor = 'us';
    else if (foeFirst > usFirst) actor = 'foe';
    const dealt = foeHpBefore !== null && foeHpAfter !== null ? foeHpBefore - foeHpAfter : null;
    const taken = ourHpBefore !== null && ourHpAfter !== null ? ourHpBefore - ourHpAfter : null;
    return {
      schema: TURN_FORECAST_SCHEMA,
      ourChoice: played,
      foeChoice: reply,
      ourAction: choiceAction(me, played),
      foeAction: reply ? choiceAction(foe, reply) : null,
      foeModel: reply ? config.opponentModel : 'none',
      ourSpecies: speciesName(ourMon),
      foeSpecies: speciesName(foeMon),
      ourHpBefore: ourHpBefore === null ? null : round4(ourHpBefore),
      foeHpBefore: foeHpBefore === null ? null : round4(foeHpBefore),
      ourHpAfter: ourHpAfter === null ? null : round4(ourHpAfter),
      foeHpAfter: foeHpAfter === null ? null : round4(foeHpAfter),
      damageDealt: dealt === null ? null : round4(dealt),
      damageTaken: taken === null ? null : round4(taken),
      ourKo: n > 0 && ourHpBefore !== null ? ourKoN / n >= 0.5 : null,
      foeKo: n > 0 && foeHpBefore !== null ? foeKoN / n >= 0.5 : null,
      firstActor: actor,
      stepped: n > 0,
      samples: n,
    };
  } catch {
    return null;
  }
}
