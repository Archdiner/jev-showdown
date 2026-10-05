import * as fs from 'fs';
import type { OpsPaths } from './paths.js';

/**
 * Live variant pool. Another facility writes `variants.json`:
 *
 * { "variants": [ { "id": "switch-depth2", "alpha": 1, "beta": 1 } ] }
 *
 * Live draws one id per game with Thompson sampling (Beta prior plus
 * logged wins and losses) and stores that id on the game. A missing or
 * empty file draws nothing.
 */
export interface VariantArm {
  id: string;
  /** Beta prior pseudo-wins. Defaults to 1. */
  alpha?: number;
  /** Beta prior pseudo-losses. Defaults to 1. */
  beta?: number;
}

export interface ArmCount {
  wins: number;
  losses: number;
}

export function loadVariantPool(paths: OpsPaths): VariantArm[] {
  if (!fs.existsSync(paths.variants)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(paths.variants, 'utf8'));
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { variants?: unknown }).variants)
      ? (parsed as { variants: unknown[] }).variants
      : [];
  const seen = new Set<string>();
  const arms: VariantArm[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = (row as { id?: unknown }).id;
    if (typeof id !== 'string' || !id.trim() || seen.has(id)) continue;
    seen.add(id);
    const alpha = (row as { alpha?: unknown }).alpha;
    const beta = (row as { beta?: unknown }).beta;
    arms.push({
      id,
      alpha: typeof alpha === 'number' && alpha > 0 ? alpha : 1,
      beta: typeof beta === 'number' && beta > 0 ? beta : 1,
    });
  }
  return arms;
}

export function observeVariant(
  counts: Record<string, ArmCount>,
  id: string | null | undefined,
  outcome: 'win' | 'loss' | 'tie',
): void {
  if (!id || outcome === 'tie') return;
  const row = counts[id] ?? { wins: 0, losses: 0 };
  if (outcome === 'win') row.wins += 1;
  else row.losses += 1;
  counts[id] = row;
}

export function countsFromLiveGames(
  records: Array<{ variantId?: string; winner?: string }>,
): Record<string, ArmCount> {
  const counts: Record<string, ArmCount> = {};
  for (const record of records) {
    if (record.winner === 'win' || record.winner === 'loss' || record.winner === 'tie') {
      observeVariant(counts, record.variantId, record.winner);
    }
  }
  return counts;
}

/** One Thompson draw. An empty pool returns null. A single arm is returned as-is. */
export function thompsonDraw(
  arms: VariantArm[],
  counts: Record<string, ArmCount>,
  rng: () => number,
): string | null {
  if (arms.length === 0) return null;
  if (arms.length === 1) return arms[0].id;
  let bestId = arms[0].id;
  let best = -1;
  for (const arm of arms) {
    const count = counts[arm.id] ?? { wins: 0, losses: 0 };
    const alpha = (arm.alpha ?? 1) + count.wins;
    const beta = (arm.beta ?? 1) + count.losses;
    const sample = sampleBeta(alpha, beta, rng);
    if (sample > best) {
      best = sample;
      bestId = arm.id;
    }
  }
  return bestId;
}

function sampleBeta(alpha: number, beta: number, rng: () => number): number {
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  const total = x + y;
  if (total <= 0) return 0.5;
  return x / total;
}

/** Marsaglia–Tsang gamma, scale 1. Shape below 1 uses the boost. */
function sampleGamma(shape: number, rng: () => number): number {
  if (shape < 1) {
    const boost = Math.max(rng(), Number.EPSILON);
    return sampleGamma(shape + 1, rng) * Math.pow(boost, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x = 0;
    let v = 0;
    do {
      x = sampleNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.max(rng(), Number.EPSILON);
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function sampleNormal(rng: () => number): number {
  const u = Math.max(rng(), Number.EPSILON);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
