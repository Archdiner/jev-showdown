export interface Allocatable {
  configId: string;
  configPath: string;
  labels: string[];
  pulled?: boolean;
}

export interface CircuitState {
  consecutiveLosses: number;
  ratings: number[];
  pulled: boolean;
  reason?: string;
}

export const EXPLORE_MIN = 0.1;
export const EXPLORE_MAX = 0.2;
export const DEFAULT_EXPLORE = 0.15;

export function clampExplore(rate: number): number {
  if (Number.isNaN(rate)) return DEFAULT_EXPLORE;
  return Math.min(EXPLORE_MAX, Math.max(EXPLORE_MIN, rate));
}

/** Champion takes the rest of the traffic. Live-approved challengers share the explore slice. */
export function allocate(configs: Allocatable[], rng: () => number, exploreRate = DEFAULT_EXPLORE): Allocatable | null {
  const rate = clampExplore(exploreRate);
  const open = configs.filter(config => !config.pulled);
  const champion = open.find(config => config.labels.includes('champion'));
  const explorers = open.filter(config => config.labels.includes('live-approved') && !config.labels.includes('champion'));
  if (!champion && explorers.length === 0) return null;
  if (!champion) return explorers[Math.floor(rng() * explorers.length)] ?? null;
  if (explorers.length === 0 || rng() >= rate) return champion;
  return explorers[Math.floor(rng() * explorers.length)] ?? champion;
}

export function nextCircuit(
  state: CircuitState | undefined,
  outcome: 'win' | 'loss' | 'tie',
  rating: number,
  limits: { maxLosses: number; maxDrop: number; window: number }
): CircuitState {
  const prior = state ?? { consecutiveLosses: 0, ratings: [], pulled: false };
  if (prior.pulled) return prior;
  const consecutiveLosses = outcome === 'loss' ? prior.consecutiveLosses + 1 : 0;
  const ratings = [...prior.ratings, rating].slice(-Math.max(2, limits.window));
  const drop = ratings.length >= 2 ? ratings[0] - ratings[ratings.length - 1] : 0;
  if (consecutiveLosses >= limits.maxLosses) {
    return { consecutiveLosses, ratings, pulled: true, reason: `${consecutiveLosses} consecutive losses` };
  }
  if (drop > limits.maxDrop) {
    return { consecutiveLosses, ratings, pulled: true, reason: `rating drop ${drop.toFixed(0)} in the window` };
  }
  return { consecutiveLosses, ratings, pulled: false };
}
