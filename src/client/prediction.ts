import { Actor, TurnForecast, hpFractionText, round4 } from './turn-forecast.js';
import { toID } from './ids.js';

export const PREDICTION_ERROR_SCHEMA = 'jev.prediction-error.v1' as const;

export interface PredictionBaseline {
  ourSide: 'p1' | 'p2';
  ourHpBefore: number | null;
  foeHpBefore: number | null;
}

export interface ObservedTurn {
  ourAction: string | null;
  foeAction: string | null;
  ourHpBefore: number | null;
  foeHpBefore: number | null;
  ourHpAfter: number | null;
  foeHpAfter: number | null;
  damageDealt: number | null;
  damageTaken: number | null;
  ourKo: boolean | null;
  foeKo: boolean | null;
  firstActor: Actor | null;
}

export interface PredictionScore {
  schema: typeof PREDICTION_ERROR_SCHEMA;
  turn: number;
  rqid: number | null;
  comparable: boolean;
  foeActionMatch: boolean | null;
  ourActionMatch: boolean | null;
  damageDealtError: number | null;
  damageTakenError: number | null;
  damageDealtAbs: number | null;
  damageTakenAbs: number | null;
  ourKoMismatch: boolean | null;
  foeKoMismatch: boolean | null;
  speedOrderMismatch: boolean | null;
  predicted: TurnForecast;
  actual: ObservedTurn;
}

/** Flat counts. Rates are filled in by `finishCalibration`. */
export interface CalibrationTotals {
  turns: number;
  compared: number;
  foeActions: number;
  foeActionCorrect: number;
  ourActions: number;
  ourActionCorrect: number;
  damageDealtN: number;
  damageDealtAbsSum: number;
  damageTakenN: number;
  damageTakenAbsSum: number;
  koCompared: number;
  koErrors: number;
  ourKoErrors: number;
  foeKoErrors: number;
  speedCompared: number;
  speedOrderErrors: number;
}

export interface CalibrationSummary extends CalibrationTotals {
  foeActionAccuracy: number | null;
  ourActionAccuracy: number | null;
  damageDealtMae: number | null;
  damageTakenMae: number | null;
  koErrorRate: number | null;
  speedOrderErrorRate: number | null;
}

export interface CalibrationSample {
  battleId: string | null;
  turn: number | null;
  rqid: number | null;
  engine: string | null;
  comparable: boolean;
  foeActionMatch: boolean | null;
  ourActionMatch: boolean | null;
  damageDealtAbs: number | null;
  damageTakenAbs: number | null;
  ourKoMismatch: boolean | null;
  foeKoMismatch: boolean | null;
  speedOrderMismatch: boolean | null;
}

export function emptyTotals(): CalibrationTotals {
  return {
    turns: 0,
    compared: 0,
    foeActions: 0,
    foeActionCorrect: 0,
    ourActions: 0,
    ourActionCorrect: 0,
    damageDealtN: 0,
    damageDealtAbsSum: 0,
    damageTakenN: 0,
    damageTakenAbsSum: 0,
    koCompared: 0,
    koErrors: 0,
    ourKoErrors: 0,
    foeKoErrors: 0,
    speedCompared: 0,
    speedOrderErrors: 0,
  };
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return round4(numerator / denominator);
}

export function finishCalibration(totals: CalibrationTotals): CalibrationSummary {
  return {
    ...totals,
    damageDealtAbsSum: round4(totals.damageDealtAbsSum),
    damageTakenAbsSum: round4(totals.damageTakenAbsSum),
    foeActionAccuracy: rate(totals.foeActionCorrect, totals.foeActions),
    ourActionAccuracy: rate(totals.ourActionCorrect, totals.ourActions),
    damageDealtMae: rate(totals.damageDealtAbsSum, totals.damageDealtN),
    damageTakenMae: rate(totals.damageTakenAbsSum, totals.damageTakenN),
    koErrorRate: rate(totals.koErrors, totals.koCompared),
    speedOrderErrorRate: rate(totals.speedOrderErrors, totals.speedCompared),
  };
}

export function addSample(totals: CalibrationTotals, sample: CalibrationSample): void {
  totals.turns += 1;
  if (!sample.comparable) return;
  totals.compared += 1;
  if (sample.foeActionMatch !== null) {
    totals.foeActions += 1;
    if (sample.foeActionMatch) totals.foeActionCorrect += 1;
  }
  if (sample.ourActionMatch !== null) {
    totals.ourActions += 1;
    if (sample.ourActionMatch) totals.ourActionCorrect += 1;
  }
  if (sample.damageDealtAbs !== null) {
    totals.damageDealtN += 1;
    totals.damageDealtAbsSum += sample.damageDealtAbs;
  }
  if (sample.damageTakenAbs !== null) {
    totals.damageTakenN += 1;
    totals.damageTakenAbsSum += sample.damageTakenAbs;
  }
  const koFlags = [sample.ourKoMismatch, sample.foeKoMismatch].filter((flag): flag is boolean => flag !== null);
  if (koFlags.length > 0) {
    totals.koCompared += 1;
    if (koFlags.some(Boolean)) totals.koErrors += 1;
    if (sample.ourKoMismatch) totals.ourKoErrors += 1;
    if (sample.foeKoMismatch) totals.foeKoErrors += 1;
  }
  if (sample.speedOrderMismatch !== null) {
    totals.speedCompared += 1;
    if (sample.speedOrderMismatch) totals.speedOrderErrors += 1;
  }
}

export function addCalibration(totals: CalibrationTotals, summary: CalibrationSummary): void {
  totals.turns += summary.turns;
  totals.compared += summary.compared;
  totals.foeActions += summary.foeActions;
  totals.foeActionCorrect += summary.foeActionCorrect;
  totals.ourActions += summary.ourActions;
  totals.ourActionCorrect += summary.ourActionCorrect;
  totals.damageDealtN += summary.damageDealtN;
  totals.damageDealtAbsSum += summary.damageDealtAbsSum;
  totals.damageTakenN += summary.damageTakenN;
  totals.damageTakenAbsSum += summary.damageTakenAbsSum;
  totals.koCompared += summary.koCompared;
  totals.koErrors += summary.koErrors;
  totals.ourKoErrors += summary.ourKoErrors;
  totals.foeKoErrors += summary.foeKoErrors;
  totals.speedCompared += summary.speedCompared;
  totals.speedOrderErrors += summary.speedOrderErrors;
}

export function summarizeSamples(samples: CalibrationSample[]): CalibrationSummary | null {
  if (samples.length === 0) return null;
  const totals = emptyTotals();
  for (const sample of samples) addSample(totals, sample);
  return finishCalibration(totals);
}

export function combineCalibrations(parts: Array<CalibrationSummary | null | undefined>): CalibrationSummary | null {
  const present = parts.filter((part): part is CalibrationSummary => !!part && part.turns > 0);
  if (present.length === 0) return null;
  const totals = emptyTotals();
  for (const part of present) addCalibration(totals, part);
  return finishCalibration(totals);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function flag(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function sumField(row: Record<string, unknown>, sumKey: string, nKey: string, maeKey: string): { n: number; sum: number } {
  const n = finite(row[nKey]) ?? 0;
  const sum = finite(row[sumKey]);
  if (sum !== null) return { n, sum };
  const mae = finite(row[maeKey]);
  if (mae !== null && n > 0) return { n, sum: mae * n };
  return { n: 0, sum: 0 };
}

export function calibrationFromUnknown(value: unknown): CalibrationSummary | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const turns = finite(row.turns);
  if (turns === null) return null;
  const dealt = sumField(row, 'damageDealtAbsSum', 'damageDealtN', 'damageDealtMae');
  const taken = sumField(row, 'damageTakenAbsSum', 'damageTakenN', 'damageTakenMae');
  return finishCalibration({
    turns,
    compared: finite(row.compared) ?? 0,
    foeActions: finite(row.foeActions) ?? 0,
    foeActionCorrect: finite(row.foeActionCorrect) ?? 0,
    ourActions: finite(row.ourActions) ?? 0,
    ourActionCorrect: finite(row.ourActionCorrect) ?? 0,
    damageDealtN: dealt.n,
    damageDealtAbsSum: dealt.sum,
    damageTakenN: taken.n,
    damageTakenAbsSum: taken.sum,
    koCompared: finite(row.koCompared) ?? 0,
    koErrors: finite(row.koErrors) ?? 0,
    ourKoErrors: finite(row.ourKoErrors) ?? 0,
    foeKoErrors: finite(row.foeKoErrors) ?? 0,
    speedCompared: finite(row.speedCompared) ?? 0,
    speedOrderErrors: finite(row.speedOrderErrors) ?? 0,
  });
}

export function sampleFromRow(row: Record<string, unknown>): CalibrationSample | null {
  const kind = String(row.type || row.kind || '');
  if (kind !== 'prediction_error' && row.schema !== PREDICTION_ERROR_SCHEMA) return null;
  if (kind && kind !== 'prediction_error') return null;
  return {
    battleId: typeof row.battleId === 'string' ? row.battleId : null,
    turn: finite(row.turn),
    rqid: finite(row.rqid),
    engine: typeof row.engine === 'string' ? row.engine : null,
    comparable: row.comparable !== false,
    foeActionMatch: flag(row.foeActionMatch),
    ourActionMatch: flag(row.ourActionMatch),
    damageDealtAbs: finite(row.damageDealtAbs),
    damageTakenAbs: finite(row.damageTakenAbs),
    ourKoMismatch: flag(row.ourKoMismatch),
    foeKoMismatch: flag(row.foeKoMismatch),
    speedOrderMismatch: flag(row.speedOrderMismatch),
  };
}

export function sampleKey(sample: CalibrationSample): string {
  return `${sample.battleId ?? ''}:${sample.turn ?? ''}:${sample.rqid ?? ''}`;
}

export function dedupeSamples(samples: CalibrationSample[]): CalibrationSample[] {
  const seen = new Set<string>();
  const out: CalibrationSample[] = [];
  for (const sample of samples) {
    const key = sampleKey(sample);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sample);
  }
  return out;
}

function otherSide(side: 'p1' | 'p2'): 'p1' | 'p2' {
  return side === 'p1' ? 'p2' : 'p1';
}

function sideOf(token: string, ourSide: 'p1' | 'p2'): Actor | null {
  if (token.startsWith(ourSide)) return 'us';
  if (token.startsWith(otherSide(ourSide))) return 'foe';
  return null;
}

function tokenSpecies(token: string): string {
  return toID(token.split(':').slice(1).join(':'));
}

function delta(before: number | null, after: number | null): number | null {
  if (before === null || after === null) return null;
  return before - after;
}

function koOf(before: number | null, after: number | null, sawFaint: boolean): boolean | null {
  if (sawFaint) return true;
  if (before === null || after === null) return null;
  return before > 0 && after <= 0;
}

const RESOLUTION = /^\|(?:move|switch|drag|faint|cant|-damage|-heal|-sethp)\|/;

/**
 * Read the protocol that followed a choice. HP deltas are for the pokemon
 * that was active when we chose, matched by species id. A switch-in is a new mon.
 */
export function observeResolution(
  lines: string[],
  forecast: TurnForecast,
  baseline: PredictionBaseline,
): ObservedTurn {
  const ourSpecies = toID(forecast.ourSpecies || '');
  const foeSpecies = toID(forecast.foeSpecies || '');
  let ourAfter = baseline.ourHpBefore;
  let foeAfter = baseline.foeHpBefore;
  let ourFaint = false;
  let foeFaint = false;
  let ourAction: string | null = null;
  let foeAction: string | null = null;
  let first: Actor | null = null;

  const applyHp = (who: Actor, raw: string) => {
    const fraction = hpFractionText(raw);
    if (fraction === null) return;
    if (who === 'us') ourAfter = fraction;
    else foeAfter = fraction;
  };

  for (const line of lines) {
    const parts = line.split('|');
    const token = parts[2] || '';
    const who = sideOf(token, baseline.ourSide);
    if (!who) continue;
    const species = tokenSpecies(token);
    const tracked = who === 'us' ? ourSpecies : foeSpecies;
    const sameMon = Boolean(tracked) && species === tracked;

    if (line.startsWith('|move|') || line.startsWith('|switch|') || line.startsWith('|drag|')) {
      if (!first) first = who;
    }
    if (line.startsWith('|move|') || line.startsWith('|switch|')) {
      const action = line.startsWith('|move|')
        ? toID(parts[3] || '')
        : `switch:${toID((parts[3] || '').split(',')[0])}`;
      if (action && action !== 'switch:') {
        if (who === 'us' && ourAction === null) ourAction = action;
        if (who === 'foe' && foeAction === null) foeAction = action;
      }
    }
    if (!sameMon) continue;
    if (line.startsWith('|-damage|') || line.startsWith('|-heal|') || line.startsWith('|-sethp|')) {
      applyHp(who, parts[3] || '');
    } else if (line.startsWith('|faint|')) {
      if (who === 'us') {
        ourFaint = true;
        ourAfter = 0;
      } else {
        foeFaint = true;
        foeAfter = 0;
      }
    }
  }

  const ourHpAfter = ourAfter === null ? null : round4(ourAfter);
  const foeHpAfter = foeAfter === null ? null : round4(foeAfter);
  const ourHpBefore = baseline.ourHpBefore === null ? null : round4(baseline.ourHpBefore);
  const foeHpBefore = baseline.foeHpBefore === null ? null : round4(baseline.foeHpBefore);
  return {
    ourAction,
    foeAction,
    ourHpBefore,
    foeHpBefore,
    ourHpAfter,
    foeHpAfter,
    damageDealt: delta(foeHpBefore, foeHpAfter) === null ? null : round4(delta(foeHpBefore, foeHpAfter) as number),
    damageTaken: delta(ourHpBefore, ourHpAfter) === null ? null : round4(delta(ourHpBefore, ourHpAfter) as number),
    ourKo: koOf(ourHpBefore, ourHpAfter, ourFaint),
    foeKo: koOf(foeHpBefore, foeHpAfter, foeFaint),
    firstActor: first,
  };
}

function diff(actual: number | null, predicted: number | null): { error: number | null; abs: number | null } {
  if (actual === null || predicted === null) return { error: null, abs: null };
  const error = actual - predicted;
  return { error: round4(error), abs: round4(Math.abs(error)) };
}

function mismatch(predicted: boolean | null, actual: boolean | null): boolean | null {
  if (predicted === null || actual === null) return null;
  return predicted !== actual;
}

export function scoreResolution(input: {
  forecast: TurnForecast;
  baseline: PredictionBaseline;
  lines: string[];
  turn: number;
  rqid: number | null;
}): PredictionScore {
  const actual = observeResolution(input.lines, input.forecast, input.baseline);
  const saw = input.lines.some(line => RESOLUTION.test(line));
  const dealt = diff(actual.damageDealt, input.forecast.damageDealt);
  const taken = diff(actual.damageTaken, input.forecast.damageTaken);
  const foeActionMatch = input.forecast.foeAction && actual.foeAction
    ? input.forecast.foeAction === actual.foeAction
    : null;
  const ourActionMatch = input.forecast.ourAction && actual.ourAction
    ? input.forecast.ourAction === actual.ourAction
    : null;
  return {
    schema: PREDICTION_ERROR_SCHEMA,
    turn: input.turn,
    rqid: input.rqid,
    comparable: saw && input.forecast.stepped,
    foeActionMatch,
    ourActionMatch,
    damageDealtError: dealt.error,
    damageTakenError: taken.error,
    damageDealtAbs: dealt.abs,
    damageTakenAbs: taken.abs,
    ourKoMismatch: mismatch(input.forecast.ourKo, actual.ourKo),
    foeKoMismatch: mismatch(input.forecast.foeKo, actual.foeKo),
    speedOrderMismatch: input.forecast.firstActor && actual.firstActor
      ? input.forecast.firstActor !== actual.firstActor
      : null,
    predicted: input.forecast,
    actual,
  };
}

export function scoreToSample(score: PredictionScore, extra?: { battleId?: string | null; engine?: string | null }): CalibrationSample {
  return {
    battleId: extra?.battleId ?? null,
    turn: score.turn,
    rqid: score.rqid,
    engine: extra?.engine ?? null,
    comparable: score.comparable,
    foeActionMatch: score.foeActionMatch,
    ourActionMatch: score.ourActionMatch,
    damageDealtAbs: score.damageDealtAbs,
    damageTakenAbs: score.damageTakenAbs,
    ourKoMismatch: score.ourKoMismatch,
    foeKoMismatch: score.foeKoMismatch,
    speedOrderMismatch: score.speedOrderMismatch,
  };
}

interface OpenTurn {
  forecast: TurnForecast;
  baseline: PredictionBaseline;
  turn: number;
  rqid: number | null;
  lines: string[];
}

/**
 * Collects protocol lines after a choice and scores them when the next
 * request or the battle result arrives. Methods do not throw.
 */
export class PredictionLog {
  private open: OpenTurn | null = null;
  private readonly scores: PredictionScore[] = [];

  start(input: {
    forecast: TurnForecast;
    baseline: PredictionBaseline;
    turn: number;
    rqid: number | null;
  }): PredictionScore | null {
    const previous = this.close();
    try {
      this.open = {
        forecast: input.forecast,
        baseline: input.baseline,
        turn: input.turn,
        rqid: input.rqid,
        lines: [],
      };
    } catch {
      this.open = null;
    }
    return previous;
  }

  observe(line: string): PredictionScore | null {
    try {
      if (line.startsWith('|request|') || line.startsWith('|win|') || line === '|tie' || line.startsWith('|tie|')) {
        return this.close();
      }
      if (this.open) this.open.lines.push(line);
      return null;
    } catch {
      return null;
    }
  }

  close(): PredictionScore | null {
    const open = this.open;
    this.open = null;
    if (!open) return null;
    try {
      const score = scoreResolution(open);
      this.scores.push(score);
      return score;
    } catch {
      return null;
    }
  }

  summary(): CalibrationSummary | null {
    try {
      return summarizeSamples(this.scores.map(score => scoreToSample(score)));
    } catch {
      return null;
    }
  }
}

function pct(rate: number | null, numerator: number, denominator: number): string {
  if (rate === null || denominator <= 0) return 'n/a';
  return `${numerator}/${denominator} (${(rate * 100).toFixed(1)}%)`;
}

function mae(value: number | null): string {
  if (value === null) return 'n/a';
  return `${value.toFixed(3)} of max HP (${(value * 100).toFixed(1)}%)`;
}

export function formatCalibrationReport(summary: CalibrationSummary | null, title = 'Sim calibration'): string {
  if (!summary || summary.turns === 0) {
    return `${title}\nno compared turns`;
  }
  return [
    title,
    `turns: ${summary.turns}  compared: ${summary.compared}`,
    `foe action: ${pct(summary.foeActionAccuracy, summary.foeActionCorrect, summary.foeActions)}`,
    `our action: ${pct(summary.ourActionAccuracy, summary.ourActionCorrect, summary.ourActions)}`,
    `damage dealt MAE: ${mae(summary.damageDealtMae)}`,
    `damage taken MAE: ${mae(summary.damageTakenMae)}`,
    `KO mismatches: ${pct(summary.koErrorRate, summary.koErrors, summary.koCompared)}  ours ${summary.ourKoErrors}  foe ${summary.foeKoErrors}`,
    `speed-order mismatches: ${pct(summary.speedOrderErrorRate, summary.speedOrderErrors, summary.speedCompared)}`,
  ].join('\n');
}

/** Protocol after each non-wait, non-preview request. One segment per choice. */
export function resolutionsAfterRequests(lines: string[]): string[][] {
  const segments: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (!line.startsWith('|request|')) {
      if (current) current.push(line);
      continue;
    }
    if (current) segments.push(current);
    let skip = true;
    const raw = line.slice('|request|'.length);
    if (raw) {
      try {
        const request = JSON.parse(raw) as { wait?: boolean; teamPreview?: boolean };
        skip = !request || request.wait === true || request.teamPreview === true;
      } catch {
        skip = true;
      }
    }
    current = skip ? null : [];
  }
  if (current) segments.push(current);
  return segments;
}
