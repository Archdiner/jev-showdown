export interface Allocatable {
  configId: string;
  configPath: string;
  labels: string[];
  pulled?: boolean;
  /** Champion loss streak or rating drop. The config stays in the playable set. */
  regression?: boolean;
}

export type CircuitScope = 'local' | 'ladder';

export interface CircuitState {
  consecutiveLosses: number;
  ratings: number[];
  pulled: boolean;
  reason?: string;
  /** Champion only. A notable streak or rating drop. Never removes the config from play. */
  regression?: boolean;
  pulledAt?: number;
  /** Epoch ms after which a pulled challenger may be scheduled again. */
  cooldownUntil?: number;
}

export interface CircuitBook {
  version: 2;
  ladder: Record<string, CircuitState>;
  local: Record<string, CircuitState>;
}

export interface CircuitLimits {
  /** Explicit challenger streak cap. Omit it and the cap comes from the baseline win rate. */
  maxLosses?: number;
  maxDrop: number;
  window: number;
  /** Expected win rate in [0, 1]. Challenger streaks and champion regression use this. */
  baselineWinRate?: number;
  role?: 'champion' | 'challenger';
  now?: number;
  cooldownMs?: number;
}

export const EXPLORE_MIN = 0.1;
export const EXPLORE_MAX = 0.2;
export const DEFAULT_EXPLORE = 0.15;
/** Prior used until a config has enough decisive games outside the current loss streak. */
export const DEFAULT_BASELINE = 0.5;
export const BASELINE_MIN_GAMES = 8;
/** A streak is notable when its probability under the baseline drops below this. */
export const STREAK_ALPHA = 0.05;
export const MIN_CHALLENGER_STREAK = 3;
export const CHALLENGER_COOLDOWN_MS = 30 * 60 * 1000;

export function clampExplore(rate: number): number {
  if (Number.isNaN(rate)) return DEFAULT_EXPLORE;
  return Math.min(EXPLORE_MAX, Math.max(EXPLORE_MIN, rate));
}

/**
 * Smallest loss streak whose chance under `baselineWinRate` is below `alpha`.
 * A 50% config needs 5. A 20% config needs 14. A config that never wins is not
 * pulled for a streak, because the streak is the baseline.
 */
export function streakLimit(baselineWinRate: number, alpha = STREAK_ALPHA): number {
  const q = 1 - clampBaseline(baselineWinRate);
  if (q <= 0) return MIN_CHALLENGER_STREAK;
  if (q >= 1) return Number.POSITIVE_INFINITY;
  const raw = Math.log(alpha) / Math.log(q);
  if (!Number.isFinite(raw) || raw <= 0) return MIN_CHALLENGER_STREAK;
  return Math.max(MIN_CHALLENGER_STREAK, Math.floor(raw) + 1);
}

/** Win rate of games before the trailing loss streak. Short samples stay at the prior. */
export function baselineFromGames(outcomes: ReadonlyArray<'win' | 'loss' | 'tie'>): number {
  let end = outcomes.length;
  while (end > 0 && outcomes[end - 1] === 'loss') end -= 1;
  let wins = 0;
  let decisive = 0;
  for (let index = 0; index < end; index++) {
    const outcome = outcomes[index];
    if (outcome === 'tie') continue;
    decisive += 1;
    if (outcome === 'win') wins += 1;
  }
  if (decisive < BASELINE_MIN_GAMES) return DEFAULT_BASELINE;
  return wins / decisive;
}

function clampBaseline(rate: number): number {
  if (!Number.isFinite(rate)) return DEFAULT_BASELINE;
  return Math.min(1, Math.max(0, rate));
}

function challengerStreakLimit(limits: CircuitLimits): number {
  if (typeof limits.maxLosses === 'number' && Number.isFinite(limits.maxLosses)) {
    return Math.max(1, Math.floor(limits.maxLosses));
  }
  return streakLimit(limits.baselineWinRate ?? DEFAULT_BASELINE);
}

/** A cooled-down challenger is playable and its streak starts over. */
export function effectiveState(state: CircuitState | undefined, now: number): CircuitState | undefined {
  if (!state?.pulled) return state;
  if (typeof state.cooldownUntil === 'number' && now >= state.cooldownUntil) {
    return {
      consecutiveLosses: 0,
      ratings: state.ratings,
      pulled: false,
    };
  }
  return state;
}

/**
 * Champion takes the rest of the traffic. Live-approved challengers share the explore slice.
 * An empty playable set is not a legal result when any config was passed in: the champion,
 * or else the first config, stays schedulable.
 */
export function allocate(configs: Allocatable[], rng: () => number, exploreRate = DEFAULT_EXPLORE): Allocatable | null {
  const rate = clampExplore(exploreRate);
  const open = openConfigs(configs);
  const champion = open.find(config => config.labels.includes('champion'));
  const explorers = open.filter(config => config.labels.includes('live-approved') && !config.labels.includes('champion'));
  if (!champion && explorers.length === 0) return null;
  if (!champion) return explorers[Math.floor(rng() * explorers.length)] ?? null;
  if (explorers.length === 0 || rng() >= rate) return champion;
  return explorers[Math.floor(rng() * explorers.length)] ?? champion;
}

function openConfigs(configs: Allocatable[]): Allocatable[] {
  const open = configs.filter(config => !config.pulled);
  if (open.length > 0 || configs.length === 0) return open;
  const keeper = configs.find(config => config.labels.includes('champion')) ?? configs[0];
  return [{ ...keeper, pulled: false }];
}

/**
 * Marks pulls for one scope. A champion is never pulled. A challenger whose cooldown
 * has elapsed is open. If that still leaves nobody, one config is forced open.
 * A champion regression swaps in the newest distinct known-good champion when one exists.
 */
export function selectionPool(
  configs: Allocatable[],
  states: Record<string, CircuitState | undefined>,
  knownGood: Allocatable[],
  now: number,
): Allocatable[] {
  const marked = configs.map(config => {
    const state = effectiveState(states[config.configId], now);
    const champion = config.labels.includes('champion');
    return {
      ...config,
      pulled: champion ? false : Boolean(state?.pulled),
      regression: champion ? Boolean(state?.regression) : false,
    };
  });
  const open = marked.filter(config => !config.pulled);
  const base = open.length > 0 ? marked : forceOpen(marked);
  const champion = base.find(config => config.labels.includes('champion') && !config.pulled);
  if (!champion?.regression) return base;
  const prior = knownGood.find(config => config.configId !== champion.configId);
  if (!prior) return base;
  const rest = base.filter(config => config.configId !== champion.configId && config.configId !== prior.configId);
  return [{ ...prior, labels: ['champion', 'live-approved'], pulled: false, regression: false }, ...rest];
}

function forceOpen(configs: Allocatable[]): Allocatable[] {
  if (configs.length === 0) return configs;
  const keeper = configs.find(config => config.labels.includes('champion')) ?? configs[0];
  return configs.map(config => config.configId === keeper.configId ? { ...config, pulled: false } : config);
}

export function nextCircuit(
  state: CircuitState | undefined,
  outcome: 'win' | 'loss' | 'tie',
  rating: number | null,
  limits: CircuitLimits,
): CircuitState {
  const now = limits.now ?? Date.now();
  const role = limits.role ?? 'challenger';
  let prior = state ?? { consecutiveLosses: 0, ratings: [], pulled: false };
  if (role === 'champion') {
    prior = { ...prior, pulled: false };
  } else {
    prior = effectiveState(prior, now) ?? prior;
    if (prior.pulled) return prior;
  }
  const consecutiveLosses = outcome === 'loss' ? prior.consecutiveLosses + 1 : 0;
  const ratings = typeof rating === 'number' && Number.isFinite(rating)
    ? [...prior.ratings, rating].slice(-Math.max(2, limits.window))
    : prior.ratings;
  const drop = ratings.length >= 2 ? ratings[0] - ratings[ratings.length - 1] : 0;
  const dropHit = drop > limits.maxDrop;
  if (role === 'champion') {
    const streakHit = consecutiveLosses >= streakLimit(limits.baselineWinRate ?? DEFAULT_BASELINE);
    const notable = streakHit || dropHit;
    return {
      consecutiveLosses,
      ratings,
      pulled: false,
      regression: notable,
      reason: notable ? hitReason(consecutiveLosses, drop, dropHit && !streakHit) : undefined,
    };
  }
  const streakHit = consecutiveLosses >= challengerStreakLimit(limits);
  if (streakHit || dropHit) {
    const cooldownMs = limits.cooldownMs ?? CHALLENGER_COOLDOWN_MS;
    return {
      consecutiveLosses,
      ratings,
      pulled: true,
      reason: hitReason(consecutiveLosses, drop, dropHit && !streakHit),
      pulledAt: now,
      cooldownUntil: now + cooldownMs,
    };
  }
  return { consecutiveLosses, ratings, pulled: false };
}

function hitReason(consecutiveLosses: number, drop: number, dropOnly: boolean): string {
  if (dropOnly) return `rating drop ${drop.toFixed(0)} in the window`;
  return `${consecutiveLosses} consecutive losses`;
}

export function emptyCircuitBook(): CircuitBook {
  return { version: 2, ladder: {}, local: {} };
}

/** Legacy flat files are the ladder scope. Local state starts empty so the two never share a streak. */
export function parseCircuitBook(raw: unknown): CircuitBook {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyCircuitBook();
  const obj = raw as Record<string, unknown>;
  if (obj.version === 2) {
    return {
      version: 2,
      ladder: sanitizeBucket(obj.ladder),
      local: sanitizeBucket(obj.local),
    };
  }
  return { version: 2, ladder: sanitizeBucket(obj), local: {} };
}

function sanitizeBucket(raw: unknown): Record<string, CircuitState> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, CircuitState> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (id === 'version' || id === 'ladder' || id === 'local') continue;
    const state = asState(value);
    if (state) out[id] = state;
  }
  return out;
}

function asState(value: unknown): CircuitState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<CircuitState>;
  if (typeof row.pulled !== 'boolean' && typeof row.consecutiveLosses !== 'number') return null;
  return {
    consecutiveLosses: typeof row.consecutiveLosses === 'number' && Number.isFinite(row.consecutiveLosses)
      ? row.consecutiveLosses
      : 0,
    ratings: Array.isArray(row.ratings)
      ? row.ratings.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
      : [],
    pulled: row.pulled === true,
    reason: typeof row.reason === 'string' ? row.reason : undefined,
    regression: row.regression === true ? true : undefined,
    pulledAt: typeof row.pulledAt === 'number' ? row.pulledAt : undefined,
    cooldownUntil: typeof row.cooldownUntil === 'number' ? row.cooldownUntil : undefined,
  };
}

/**
 * One finished game updates one scope. Local games do not append a rating, so a
 * local Elo series cannot move the ladder drop check.
 */
export function noteOutcome(
  book: CircuitBook,
  scope: CircuitScope,
  configId: string,
  outcome: 'win' | 'loss' | 'tie',
  rating: number | null,
  limits: CircuitLimits,
): CircuitBook {
  const next: CircuitBook = {
    version: 2,
    ladder: { ...book.ladder },
    local: { ...book.local },
  };
  next[scope] = { ...book[scope] };
  next[scope][configId] = nextCircuit(
    book[scope][configId],
    outcome,
    scope === 'local' ? null : rating,
    limits,
  );
  return next;
}

/**
 * A champion pull is not enforceable. Clearing it here is what lets the next
 * ladder start schedule games after a sticky `circuits.json`.
 */
export function releaseChampionPulls(
  states: Record<string, CircuitState>,
  configs: Allocatable[],
): boolean {
  let changed = false;
  for (const config of configs) {
    if (!config.labels.includes('champion')) continue;
    const state = states[config.configId];
    if (!state?.pulled) continue;
    states[config.configId] = {
      consecutiveLosses: state.consecutiveLosses,
      ratings: state.ratings,
      pulled: false,
      regression: state.regression,
      reason: state.reason,
    };
    changed = true;
  }
  const playable = configs.some(config => {
    if (config.labels.includes('champion')) return true;
    return !states[config.configId]?.pulled;
  });
  if (!playable && configs.length > 0) {
    const keeper = configs[0];
    const state = states[keeper.configId];
    if (state?.pulled) {
      states[keeper.configId] = {
        consecutiveLosses: state.consecutiveLosses,
        ratings: state.ratings,
        pulled: false,
        reason: state.reason,
      };
      changed = true;
    }
  }
  return changed;
}
