import fs from 'fs';
import path from 'path';

/**
 * Shared meta research. The strategist agent reads the same files.
 * Search order prefers a file that agent writes, then this tree.
 * The jev-solo `hypotheses` block pastes them when that block is enabled.
 */
export const META_CANDIDATES = {
  guidance: ['state/meta/guidance.json', 'state/meta-guidance.json', 'data/meta/guidance.json'],
  replayStats: ['state/meta/replay-stats.json', 'state/replay-stats.json', 'data/meta/replay-stats.json'],
  hypotheses: ['state/meta/hypotheses.json', 'data/meta/hypotheses.json'],
} as const;

export interface Principle {
  id: string;
  topic: string;
  principle: string;
  when_applies: string;
  source_url?: string;
  confidence: 'high' | 'medium' | 'low' | string;
}

export interface ReplayBucket {
  n: number;
  hard_switch_rate: number;
  hard_switch_early: number;
  hard_switch_mid: number;
  hard_switch_late: number;
  turn1_hard_switch_pct: number;
  turns_median?: number;
  player_tera_rate?: number;
  tera_turn_median?: number;
  tera_offensive_stab_pct?: number;
  tera_other_defensive_pct?: number;
  setup_move_share?: number;
  status_move_share?: number;
  hazard_move_share?: number;
  pivot_move_share?: number;
  recovery_move_share?: number;
  games_with_any_hazard_pct?: number;
  first_hazard_turn_median?: number;
  winner_mons_left_median?: number;
}

export interface ReplayStatsFile {
  hi: ReplayBucket;
  mid?: ReplayBucket;
  low?: ReplayBucket;
}

/** Turn bins for the published early / mid / late columns. Versioned, not tuned per species. */
export const SWITCH_PHASE_V1 = {
  version: 1,
  earlyThroughTurn: 7,
  midThroughTurn: 15,
} as const;

export type SwitchPhase = 'turn1' | 'early' | 'mid' | 'late';

let guidanceCache: Principle[] | null = null;
let replayCache: ReplayStatsFile | null = null;

export function resetMetaCache(): void {
  guidanceCache = null;
  replayCache = null;
}

export function resolveMetaPath(candidates: readonly string[]): string | null {
  for (const relative of candidates) {
    const full = path.join(process.cwd(), relative);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

export function loadGuidance(): Principle[] {
  if (guidanceCache) return guidanceCache;
  const file = resolveMetaPath(META_CANDIDATES.guidance);
  if (!file) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Principle[];
  guidanceCache = Array.isArray(parsed) ? parsed : [];
  return guidanceCache;
}

export function loadReplayStats(): ReplayStatsFile | null {
  if (replayCache) return replayCache;
  const file = resolveMetaPath(META_CANDIDATES.replayStats);
  if (!file) return null;
  replayCache = JSON.parse(fs.readFileSync(file, 'utf8')) as ReplayStatsFile;
  return replayCache;
}

export function loadHypotheses(): unknown[] {
  const file = resolveMetaPath(META_CANDIDATES.hypotheses);
  if (!file) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(parsed) ? parsed : [];
}

export function switchPhase(turn: number): SwitchPhase {
  if (turn <= 1) return 'turn1';
  if (turn <= SWITCH_PHASE_V1.earlyThroughTurn) return 'early';
  if (turn <= SWITCH_PHASE_V1.midThroughTurn) return 'mid';
  return 'late';
}

export function switchPriorPercent(turn: number, bucket: ReplayBucket = loadReplayStats()?.hi ?? EMPTY_BUCKET): number {
  const phase = switchPhase(turn);
  if (phase === 'turn1') return bucket.turn1_hard_switch_pct;
  if (phase === 'early') return bucket.hard_switch_early;
  if (phase === 'mid') return bucket.hard_switch_mid;
  return bucket.hard_switch_late;
}

const EMPTY_BUCKET: ReplayBucket = {
  n: 0,
  hard_switch_rate: 0,
  hard_switch_early: 0,
  hard_switch_mid: 0,
  hard_switch_late: 0,
  turn1_hard_switch_pct: 0,
};
