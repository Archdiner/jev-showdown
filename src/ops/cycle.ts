import type { OpsPaths } from './paths.js';
import { appendJsonl, readJsonl } from './paths.js';

/** A streak of reviewed losses that queue nothing pages after this long. */
export const STALL_MS = 15 * 60 * 1000;

/** Consecutive analyst passes, or matching loss/test rows, that mean the loop is not learning. */
export const DEGENERATE_STREAK = 3;

export interface CycleTotals {
  lossesReviewed: number;
  hypothesesCreated: number;
  jobsQueued: number;
  jobsTested: number;
  promoted: number;
  rejected: number;
}

export interface CyclePass {
  lossesReviewed: number;
  hypothesesCreated: number;
  jobsQueued: number;
  skipped: number;
}

export type CycleEvent =
  | { ts: number; type: 'loss'; hypotheses: number; queued: number; reason?: string }
  | { ts: number; type: 'seed'; queued: number }
  | { ts: number; type: 'pass' } & CyclePass
  | { ts: number; type: 'tested'; summary?: string }
  | { ts: number; type: 'promoted'; reason: string }
  | { ts: number; type: 'rejected'; reason: string };

export interface CycleView {
  totals: CycleTotals;
  latest: CyclePass;
  rejectReasons: string[];
  lastSkip: string | null;
  lastTest: string | null;
  quietSince: number | null;
  quietLosses: number;
}

export function emptyCycle(): CycleView {
  return {
    totals: {
      lossesReviewed: 0,
      hypothesesCreated: 0,
      jobsQueued: 0,
      jobsTested: 0,
      promoted: 0,
      rejected: 0,
    },
    latest: { lossesReviewed: 0, hypothesesCreated: 0, jobsQueued: 0, skipped: 0 },
    rejectReasons: [],
    lastSkip: null,
    lastTest: null,
    quietSince: null,
    quietLosses: 0,
  };
}

export function clipReason(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed;
}

export function recordLoss(
  paths: OpsPaths,
  event: { hypotheses: number; queued: number; reason?: string },
  now = Date.now(),
): void {
  appendJsonl(paths.cycle, {
    ts: now,
    type: 'loss',
    hypotheses: event.hypotheses,
    queued: event.queued,
    ...(event.reason ? { reason: clipReason(event.reason) } : {}),
  } satisfies CycleEvent);
}

export function recordSeed(paths: OpsPaths, queued: number, now = Date.now()): void {
  if (queued <= 0) return;
  appendJsonl(paths.cycle, { ts: now, type: 'seed', queued } satisfies CycleEvent);
}

export function recordPass(paths: OpsPaths, pass: CyclePass, now = Date.now()): void {
  appendJsonl(paths.cycle, { ts: now, type: 'pass', ...pass } satisfies CycleEvent);
}

export function recordTested(paths: OpsPaths, summary: string, now = Date.now()): void {
  appendJsonl(paths.cycle, { ts: now, type: 'tested', summary: clipReason(summary) } satisfies CycleEvent);
}

export function recordPromoted(paths: OpsPaths, reason: string, now = Date.now()): void {
  appendJsonl(paths.cycle, { ts: now, type: 'promoted', reason: clipReason(reason) } satisfies CycleEvent);
}

export function recordRejected(paths: OpsPaths, reason: string, now = Date.now()): void {
  appendJsonl(paths.cycle, { ts: now, type: 'rejected', reason: clipReason(reason) } satisfies CycleEvent);
}

export function readCycle(paths: OpsPaths): CycleView {
  return foldCycle(readJsonl<unknown>(paths.cycle));
}

export function foldCycle(rows: unknown[]): CycleView {
  const view = emptyCycle();
  for (const row of rows) {
    const event = asEvent(row);
    if (!event) continue;
    if (event.type === 'loss') {
      view.totals.lossesReviewed += 1;
      view.totals.hypothesesCreated += Math.max(0, event.hypotheses);
      view.totals.jobsQueued += Math.max(0, event.queued);
      if (event.queued > 0) {
        view.quietSince = null;
        view.quietLosses = 0;
      } else {
        if (view.quietSince === null) view.quietSince = event.ts;
        view.quietLosses += 1;
        if (event.reason) view.lastSkip = event.reason;
      }
    } else if (event.type === 'seed') {
      view.totals.jobsQueued += Math.max(0, event.queued);
      if (event.queued > 0) {
        view.quietSince = null;
        view.quietLosses = 0;
      }
    } else if (event.type === 'pass') {
      view.latest = {
        lossesReviewed: event.lossesReviewed,
        hypothesesCreated: event.hypothesesCreated,
        jobsQueued: event.jobsQueued,
        skipped: event.skipped,
      };
    } else if (event.type === 'tested') {
      view.totals.jobsTested += 1;
      if (event.summary) view.lastTest = event.summary;
    } else if (event.type === 'promoted') {
      view.totals.promoted += 1;
    } else if (event.type === 'rejected') {
      view.totals.rejected += 1;
      view.rejectReasons.push(event.reason);
    }
  }
  if (view.rejectReasons.length > 8) view.rejectReasons = view.rejectReasons.slice(-8);
  return view;
}

export function stallAlert(view: CycleView, now: number): { level: 'P1'; message: string } | null {
  if (view.quietLosses <= 0 || view.quietSince === null) return null;
  const elapsed = now - view.quietSince;
  if (elapsed < STALL_MS) return null;
  const minutes = Math.max(15, Math.round(elapsed / 60_000));
  const why = view.lastSkip ? ` (${view.lastSkip})` : '';
  return {
    level: 'P1',
    message: `losses reviewed ${view.quietLosses} but nothing queued for ${minutes} min${why}`,
  };
}

/**
 * The loop is repeating itself: several passes queue nothing, every mine fails,
 * every loss names one variant, or every challenger result is the same string.
 */
export function degenerateAlert(rows: unknown[]): { level: 'P1'; message: string } | null {
  const events = rows.map(asEvent).filter((event): event is CycleEvent & { ts: number } => Boolean(event));
  const passes = events.filter(event => event.type === 'pass');
  const lastPasses = passes.slice(-DEGENERATE_STREAK);
  if (
    lastPasses.length >= DEGENERATE_STREAK
    && lastPasses.every(event => event.type === 'pass' && event.jobsQueued === 0 && event.lossesReviewed > 0)
  ) {
    return {
      level: 'P1',
      message: `${DEGENERATE_STREAK} consecutive analyst passes reviewed losses and queued 0 jobs`,
    };
  }
  const losses = events.filter(event => event.type === 'loss');
  if (losses.length >= DEGENERATE_STREAK && losses.every(event => (event.type === 'loss' ? event.reason ?? '' : '').includes('skipped mine'))) {
    return {
      level: 'P1',
      message: `mining failed on all ${losses.length} reviewed losses`,
    };
  }
  if (losses.length >= DEGENERATE_STREAK) {
    const variants = new Set(losses.map(event => event.type === 'loss' ? variantToken(event.reason) : null).filter((id): id is string => Boolean(id)));
    if (variants.size === 1) {
      const id = [...variants][0];
      return {
        level: 'P1',
        message: `${losses.length} losses collapsed to one hypothesis (${id})`,
      };
    }
  }
  const tested = events.filter(event => event.type === 'tested' && event.summary);
  if (tested.length >= DEGENERATE_STREAK) {
    const summaries = new Set(tested.map(event => event.type === 'tested' ? event.summary : ''));
    if (summaries.size === 1) {
      return {
        level: 'P1',
        message: `${tested.length} challenger results are identical (${[...summaries][0]})`,
      };
    }
  }
  return null;
}

function variantToken(reason: string | undefined): string | null {
  if (!reason) return null;
  const named = /variant ([a-z0-9-]+)/i.exec(reason);
  if (named) return named[1];
  const term = /eval-term:\s*([A-Za-z]+)/.exec(reason);
  if (term) return term[1];
  const mechanism = /mechanism:\s*([a-z0-9-]+)/.exec(reason);
  if (mechanism) return mechanism[1];
  return null;
}

export function cycleLines(view: CycleView, now: number): string[] {
  const totals = view.totals;
  const latest = view.latest;
  const alert = stallAlert(view, now);
  const lines = [
    `cycle losses ${totals.lossesReviewed}  hypotheses ${totals.hypothesesCreated}  queued ${totals.jobsQueued}  tested ${totals.jobsTested}  promoted ${totals.promoted}  rejected ${totals.rejected}`,
    `last pass losses ${latest.lossesReviewed}  hypotheses ${latest.hypothesesCreated}  queued ${latest.jobsQueued}  skipped ${latest.skipped}`,
    `rejected why: ${view.rejectReasons.length ? view.rejectReasons.slice(-3).join('; ') : 'none'}`,
  ];
  if (view.lastSkip) lines.push(`last skip: ${view.lastSkip}`);
  if (view.lastTest) lines.push(`last test: ${view.lastTest}`);
  lines.push(alert ? `alert ${alert.level}  ${alert.message}` : 'alert none');
  return lines;
}

function asEvent(row: unknown): (CycleEvent & { ts: number }) | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  if (typeof record.ts !== 'number' || typeof record.type !== 'string') return null;
  if (record.type === 'loss') {
    return {
      ts: record.ts,
      type: 'loss',
      hypotheses: numberOf(record.hypotheses),
      queued: numberOf(record.queued),
      ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
    };
  }
  if (record.type === 'seed') return { ts: record.ts, type: 'seed', queued: numberOf(record.queued) };
  if (record.type === 'pass') {
    return {
      ts: record.ts,
      type: 'pass',
      lossesReviewed: numberOf(record.lossesReviewed),
      hypothesesCreated: numberOf(record.hypothesesCreated),
      jobsQueued: numberOf(record.jobsQueued),
      skipped: numberOf(record.skipped),
    };
  }
  if (record.type === 'tested') {
    return {
      ts: record.ts,
      type: 'tested',
      ...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
    };
  }
  if (record.type === 'promoted' && typeof record.reason === 'string') {
    return { ts: record.ts, type: 'promoted', reason: record.reason };
  }
  if (record.type === 'rejected' && typeof record.reason === 'string') {
    return { ts: record.ts, type: 'rejected', reason: record.reason };
  }
  return null;
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
