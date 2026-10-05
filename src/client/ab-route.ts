import { createHash } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import { buildBot } from '../config/bot.js';
import { loadConfig } from '../config/load.js';
import { EngineName, parseEngine } from './engines.js';
import { ladderConfigId, ladderPolicy, policyHash } from './ladder-engine.js';

/**
 * Live A/B routing inside one ladder process.
 *
 * A battle's config is a hash of its room id, so the same room keeps the
 * same arm. Concurrency, the turn timer, and the choice watchdog stay on
 * the shared driver. The ladder CLI takes the per-account exclusive lock
 * once for the whole process, before login. This module does not log in
 * and does not take that lock again.
 */

export type AbRole = 'champion' | 'challenger';

/**
 * A challenger loss streak at least this long is a regression flag.
 * It is telemetry only. It does not bench the arm or change its share.
 */
export const AB_REGRESSION_STREAK = 4;

/** A realized share is checked only after a batch has at least this many games. */
export const AB_SHARE_MIN_GAMES = 15;

/** Normal approximation. A gap wider than this many standard errors is outside binomial noise. */
export const AB_SHARE_Z = 1.96;

/** Shares are stored as millionths so 0.1 + 0.2 + 0.7 stays exact. */
const SHARE_UNITS = 1_000_000;

export type PullReason = 'invalid-move' | 'timer-loss' | 'decision-timeout' | 'crash' | 'fallback-flood';

/**
 * Cumulative health counts that bench a challenger for the rest of the batch.
 * A loss streak is not one of these.
 */
export interface AbHealthLimits {
  /** Invalid choices, summed across the batch. */
  invalidChoices: number;
  /** Crashes, summed across the batch. */
  crashes: number;
  /** Timer losses (`our-timer`) plus decision timeouts, summed across the batch. */
  timerOrDecision: number;
  /** Choice fallbacks, summed across the batch. One tight clock is not a flood. */
  fallbackFlood: number;
}

export const DEFAULT_AB_HEALTH: AbHealthLimits = {
  invalidChoices: 1,
  crashes: 1,
  timerOrDecision: 1,
  fallbackFlood: 5,
};

export interface AbSessionOptions {
  health?: Partial<AbHealthLimits>;
  /** Loss streak that sets the regression flag. It does not bench the arm. */
  regressionStreak?: number;
  /** Fired when a challenger streak first crosses the regression flag. Scheduling is unchanged. */
  onRegression?: (note: { configId: string; streak: number; battleId: string }) => void;
}

export const AB_INCIDENT_SCHEMA = 'jev.ab-incident.v1' as const;

export interface AbArm {
  configId: string;
  configHash: string;
  configPath: string | null;
  role: AbRole;
  /** Fraction of new battles this arm was given. Champion holds the remainder. */
  share: number;
  engine: EngineName;
}

export interface AbPlan {
  arms: AbArm[];
}

export interface AbAssignment extends AbArm {
  /** True when the hashed arm was already pulled and this battle plays the champion. */
  redirected: boolean;
}

export interface AbCanary {
  configId: string;
  configHash: string;
  configPath: string | null;
  role: AbRole;
  share: number;
  engine: EngineName;
}

export interface AbIncident {
  schema: typeof AB_INCIDENT_SCHEMA;
  ts: number;
  battleId: string;
  configId: string;
  role: 'challenger';
  share: number;
  reason: PullReason;
  streak: number;
  detail: string;
}

export interface AbGameFact {
  battleId: string;
  configId: string | null;
  role?: AbRole | null;
  outcome: 'win' | 'loss' | 'tie';
  endReason: string;
  invalidChoices: number;
  crashes: number;
  /** Choice fallbacks in this game. Omitted means none. */
  fallbacks?: number;
  /** Engine or decision timeouts in this game. A low clock fallback is not one of these. */
  decisionTimeouts?: number;
  /** Ghost room from a drain. It did not play, so it cannot bench a challenger. */
  phantom?: boolean;
}

export interface AbArmShare {
  configId: string;
  role: AbRole;
  engine: EngineName;
  configPath: string | null;
  /** Configured fraction. Same value as `configuredShare`, kept for readers of the old summary. */
  share: number;
  configuredShare: number;
  games: number;
  realizedShare: number;
  benched: boolean;
  lossStreak: number;
  regression: boolean;
}

interface HealthTally {
  invalid: number;
  crashes: number;
  timers: number;
  decisionTimeouts: number;
  fallbacks: number;
}

interface ResolvedRef {
  configId: string;
  configHash: string;
  configPath: string | null;
  engine: EngineName;
}

export interface ResolveAbInput {
  champion: ResolvedRef;
  /** Raw `--ab <config>:<share>` values, in flag order. */
  specs: string[];
  /** Process engine. Yaml arms stamp this when their search layer is not max-damage. */
  hostEngine?: EngineName;
  root?: string;
  load?: (configPath: string) => { configId: string; config?: { search?: { id?: string } } };
  prove?: (configPath: string) => void;
}

/** `--ab configs/panel/maxdamage.yaml:0.2` or `--ab max-damage:0.2`. Share is a fraction in (0, 1]. */
export function parseAbSpec(value: string): { ref: string; share: number } {
  const cut = value.lastIndexOf(':');
  if (cut <= 0 || cut === value.length - 1) {
    throw new Error(`--ab must be <config>:<share> (got ${JSON.stringify(value)})`);
  }
  const ref = value.slice(0, cut).trim();
  const share = Number(value.slice(cut + 1));
  if (!ref) throw new Error(`--ab must be <config>:<share> (got ${JSON.stringify(value)})`);
  if (!Number.isFinite(share) || share <= 0 || share > 1) {
    throw new Error(`--ab share must be a fraction in (0, 1] (got ${JSON.stringify(value)})`);
  }
  if (shareUnits(share) <= 0) {
    throw new Error(`--ab share is too small (got ${JSON.stringify(value)})`);
  }
  return { ref, share };
}

export function shareUnits(share: number): number {
  return Math.round(share * SHARE_UNITS);
}

/** Unit interval [0, 1) from the battle id. Stable across processes. */
export function battleBucket(battleId: string): number {
  const digest = createHash('sha256').update(battleId).digest();
  const n = digest.readUIntBE(0, 6);
  return n / 0x1_0000_0000_0000;
}

export function buildPlan(champion: ResolvedRef, challengers: Array<ResolvedRef & { share: number }>): AbPlan {
  const seen = new Set<string>([champion.configId]);
  let used = 0;
  const arms: AbArm[] = [];
  for (const challenger of challengers) {
    if (seen.has(challenger.configId)) {
      throw new Error(`--ab config ${challenger.configId} is already in this batch`);
    }
    seen.add(challenger.configId);
    const units = shareUnits(challenger.share);
    used += units;
    if (used > SHARE_UNITS) {
      throw new Error('--ab shares must sum to at most 1');
    }
    arms.push({
      configId: challenger.configId,
      configHash: challenger.configHash,
      configPath: challenger.configPath,
      role: 'challenger',
      share: units / SHARE_UNITS,
      engine: challenger.engine,
    });
  }
  const championUnits = SHARE_UNITS - used;
  return {
    arms: [
      {
        configId: champion.configId,
        configHash: champion.configHash,
        configPath: champion.configPath,
        role: 'champion',
        share: championUnits / SHARE_UNITS,
        engine: champion.engine,
      },
      ...arms,
    ],
  };
}

export function resolveAbPlan(input: ResolveAbInput): AbPlan {
  const host = input.hostEngine ?? input.champion.engine;
  const load = input.load ?? ((configPath: string) => loadConfig(configPath));
  const prove = input.prove ?? ((configPath: string) => {
    buildBot(configPath, 'ladder');
  });
  const root = input.root ?? process.cwd();
  const challengers = input.specs.map(spec => {
    const parsed = parseAbSpec(spec);
    const resolved = resolveRef(parsed.ref, host, root, load, prove);
    return { ...resolved, share: parsed.share };
  });
  return buildPlan(input.champion, challengers);
}

/** One canary per arm. A live preflight runs each of these before searching. */
export function preflightCanaries(plan: AbPlan): AbCanary[] {
  return plan.arms.map(arm => ({
    configId: arm.configId,
    configHash: arm.configHash,
    configPath: arm.configPath,
    role: arm.role,
    share: arm.share,
    engine: arm.engine,
  }));
}

export function formatAbPlan(plan: AbPlan): string {
  const parts = plan.arms.map(arm => {
    const file = arm.configPath ? ` path=${arm.configPath}` : '';
    return `${arm.role} ${arm.configId} share=${arm.share} engine=${arm.engine}${file}`;
  });
  return `[ladder] ab ${parts.join(' | ')}`;
}

export function formatAbCanary(canary: AbCanary): string {
  const file = canary.configPath ? ` path=${canary.configPath}` : '';
  return `[ladder] preflight canary role=${canary.role} id=${canary.configId} share=${canary.share} engine=${canary.engine}${file}`;
}

/**
 * Hash the battle id into the share buckets. A benched challenger falls
 * through to the champion. The champion arm is never benched. A loss streak
 * does not bench anyone.
 */
export function assignArm(battleId: string, arms: readonly AbArm[], pulled: ReadonlySet<string>): AbAssignment {
  if (arms.length === 0) throw new Error('ab plan has no arms');
  const champion = arms.find(arm => arm.role === 'champion') ?? arms[0];
  const ticket = Math.min(SHARE_UNITS - 1, Math.floor(battleBucket(battleId) * SHARE_UNITS));
  let cursor = 0;
  let chosen = champion;
  for (const arm of arms) {
    cursor += shareUnits(arm.share);
    if (ticket < cursor) {
      chosen = arm;
      break;
    }
  }
  if (chosen.role === 'challenger' && pulled.has(chosen.configId)) {
    return { ...champion, redirected: true };
  }
  return { ...chosen, redirected: false };
}

export class AbSession {
  private readonly pulled = new Set<string>();
  private readonly streak = new Map<string, number>();
  private readonly regression = new Set<string>();
  private readonly health = new Map<string, HealthTally>();
  /** Faults already added for a battle, so the game row does not count them twice. */
  private readonly countedFault = new Map<string, { invalid: number; crashes: number }>();
  private readonly byBattle = new Map<string, AbAssignment>();
  private readonly noted = new Set<string>();
  private readonly limits: AbHealthLimits;
  private readonly regressionStreak: number;
  private readonly onRegression?: (note: { configId: string; streak: number; battleId: string }) => void;
  readonly incidents: AbIncident[] = [];

  constructor(
    readonly plan: AbPlan,
    private readonly onIncident?: (incident: AbIncident) => void,
    options: AbSessionOptions = {},
  ) {
    this.limits = resolveHealth(options.health);
    this.regressionStreak = resolveStreak(options.regressionStreak);
    this.onRegression = options.onRegression;
  }

  assign(battleId: string): AbAssignment {
    const existing = this.byBattle.get(battleId);
    if (existing) return existing;
    const assignment = assignArm(battleId, this.plan.arms, this.pulled);
    this.byBattle.set(battleId, assignment);
    return assignment;
  }

  isPulled(configId: string): boolean {
    return this.pulled.has(configId);
  }

  pulledIds(): string[] {
    return [...this.pulled];
  }

  lossStreak(configId: string): number {
    return this.streak.get(configId) ?? 0;
  }

  isRegression(configId: string): boolean {
    return this.regression.has(configId);
  }

  regressionIds(): string[] {
    return [...this.regression];
  }

  /**
   * Realized games of each arm divided by the games the caller passes.
   * Pass the played rows (phantoms already dropped). The denominator is that list.
   */
  shareReport(games: ReadonlyArray<{ configId?: string | null }>): AbArmShare[] {
    const total = games.length;
    return this.plan.arms.map(arm => {
      const played = games.filter(game => game.configId === arm.configId).length;
      return {
        configId: arm.configId,
        role: arm.role,
        engine: arm.engine,
        configPath: arm.configPath,
        share: arm.share,
        configuredShare: arm.share,
        games: played,
        realizedShare: total === 0 ? 0 : played / total,
        benched: this.pulled.has(arm.configId),
        lossStreak: this.streak.get(arm.configId) ?? 0,
        regression: this.regression.has(arm.configId),
      };
    });
  }

  /** An invalid move or an in-battle crash. Later games of that challenger play the champion once the threshold is met. */
  noteFault(battleId: string, fault: 'invalid-move' | 'crash'): AbIncident | null {
    const assignment = this.byBattle.get(battleId);
    if (!assignment || assignment.role !== 'challenger' || assignment.redirected) return null;
    if (this.pulled.has(assignment.configId)) return null;
    const prior = this.countedFault.get(battleId) ?? { invalid: 0, crashes: 0 };
    if (fault === 'invalid-move') {
      if (prior.invalid > 0) return null;
      prior.invalid = 1;
      this.tally(assignment.configId).invalid += 1;
    } else {
      if (prior.crashes > 0) return null;
      prior.crashes = 1;
      this.tally(assignment.configId).crashes += 1;
    }
    this.countedFault.set(battleId, prior);
    return this.maybeBench(assignment, battleId);
  }

  /**
   * Game end. Health failures bench the challenger once their threshold is met.
   * A loss streak is recorded and can flag a regression. It does not change the share.
   */
  noteGame(game: AbGameFact): AbIncident | null {
    if (this.noted.has(game.battleId)) return null;
    this.noted.add(game.battleId);
    if (game.phantom) return null;
    if (game.role !== 'challenger' || !game.configId) return null;
    const assignment = this.assignmentFor(game);
    if (!assignment || assignment.redirected) return null;
    if (this.pulled.has(assignment.configId)) return null;

    const counted = this.countedFault.get(game.battleId) ?? { invalid: 0, crashes: 0 };
    const tally = this.tally(assignment.configId);
    tally.invalid += Math.max(0, game.invalidChoices - counted.invalid);
    const crashes = game.crashes + (game.endReason === 'crash' && game.crashes === 0 ? 1 : 0);
    tally.crashes += Math.max(0, crashes - counted.crashes);
    if (game.endReason === 'our-timer') tally.timers += 1;
    tally.decisionTimeouts += Math.max(0, game.decisionTimeouts ?? 0);
    tally.fallbacks += Math.max(0, game.fallbacks ?? 0);
    this.noteStreak(assignment.configId, game);
    return this.maybeBench(assignment, game.battleId);
  }

  private assignmentFor(game: AbGameFact): AbAssignment | null {
    const stored = this.byBattle.get(game.battleId);
    if (stored) return stored;
    const arm = this.plan.arms.find(item => item.configId === game.configId && item.role === 'challenger');
    if (!arm) return null;
    return { ...arm, redirected: false };
  }

  private tally(configId: string): HealthTally {
    const existing = this.health.get(configId);
    if (existing) return existing;
    const created: HealthTally = { invalid: 0, crashes: 0, timers: 0, decisionTimeouts: 0, fallbacks: 0 };
    this.health.set(configId, created);
    return created;
  }

  private noteStreak(configId: string, game: AbGameFact): void {
    if (game.outcome !== 'loss') {
      this.streak.set(configId, 0);
      this.regression.delete(configId);
      return;
    }
    const streak = (this.streak.get(configId) ?? 0) + 1;
    this.streak.set(configId, streak);
    if (streak < this.regressionStreak || this.regression.has(configId)) return;
    this.regression.add(configId);
    this.onRegression?.({ configId, streak, battleId: game.battleId });
  }

  private maybeBench(assignment: AbAssignment, battleId: string): AbIncident | null {
    const tally = this.tally(assignment.configId);
    const reason = benchReason(tally, this.limits);
    if (!reason) return null;
    return this.pull(assignment, battleId, reason, this.streak.get(assignment.configId) ?? 0, tally);
  }

  private pull(
    assignment: AbAssignment,
    battleId: string,
    reason: PullReason,
    streak: number,
    tally: HealthTally,
  ): AbIncident | null {
    if (assignment.role !== 'challenger') return null;
    if (this.pulled.has(assignment.configId)) return null;
    this.pulled.add(assignment.configId);
    const incident: AbIncident = {
      schema: AB_INCIDENT_SCHEMA,
      ts: Date.now(),
      battleId,
      configId: assignment.configId,
      role: 'challenger',
      share: assignment.share,
      reason,
      streak,
      detail: pullDetail(reason, tally),
    };
    this.incidents.push(incident);
    this.onIncident?.(incident);
    return incident;
  }
}

export function appendAbIncident(dir: string, incident: AbIncident): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'incidents.jsonl'), `${JSON.stringify(incident)}\n`);
}

function pullDetail(reason: PullReason, tally: HealthTally): string {
  if (reason === 'invalid-move') return `${tally.invalid} invalid choices`;
  if (reason === 'timer-loss') return `${tally.timers} timer losses`;
  if (reason === 'decision-timeout') return `${tally.decisionTimeouts} decision timeouts`;
  if (reason === 'fallback-flood') return `${tally.fallbacks} choice fallbacks`;
  return `${tally.crashes} crashes`;
}

function benchReason(tally: HealthTally, limits: AbHealthLimits): PullReason | null {
  if (tally.invalid >= limits.invalidChoices) return 'invalid-move';
  if (tally.crashes >= limits.crashes) return 'crash';
  if (tally.timers + tally.decisionTimeouts >= limits.timerOrDecision) {
    return tally.timers > 0 ? 'timer-loss' : 'decision-timeout';
  }
  if (tally.fallbacks >= limits.fallbackFlood) return 'fallback-flood';
  return null;
}

export function resolveHealth(partial: Partial<AbHealthLimits> | undefined): AbHealthLimits {
  return {
    invalidChoices: healthLimit(partial?.invalidChoices, DEFAULT_AB_HEALTH.invalidChoices),
    crashes: healthLimit(partial?.crashes, DEFAULT_AB_HEALTH.crashes),
    timerOrDecision: healthLimit(partial?.timerOrDecision, DEFAULT_AB_HEALTH.timerOrDecision),
    fallbackFlood: healthLimit(partial?.fallbackFlood, DEFAULT_AB_HEALTH.fallbackFlood),
  };
}

function healthLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function resolveStreak(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return AB_REGRESSION_STREAK;
  return Math.max(1, Math.floor(value));
}

/**
 * `--ab-health invalid=1,crashes=1,timer=1,fallbacks=5`.
 * Omitted keys keep the defaults. A loss streak is not a key.
 */
export function parseAbHealth(value: string): Partial<AbHealthLimits> {
  const out: Partial<AbHealthLimits> = {};
  const text = value.trim();
  if (!text) return out;
  for (const part of text.split(',')) {
    const cut = part.indexOf('=');
    if (cut <= 0) throw new Error(`--ab-health must look like invalid=1,crashes=1,timer=1,fallbacks=5 (got ${JSON.stringify(value)})`);
    const key = part.slice(0, cut).trim();
    const raw = Number(part.slice(cut + 1));
    if (!Number.isFinite(raw) || raw < 1) {
      throw new Error(`--ab-health ${key} must be a positive integer (got ${JSON.stringify(value)})`);
    }
    if (key === 'invalid') out.invalidChoices = raw;
    else if (key === 'crashes') out.crashes = raw;
    else if (key === 'timer') out.timerOrDecision = raw;
    else if (key === 'fallbacks') out.fallbackFlood = raw;
    else throw new Error(`--ab-health unknown key ${JSON.stringify(key)}`);
  }
  return out;
}

/**
 * True when the arm's realized count is outside a normal approximation of
 * Binomial(batchGames, configuredShare). Batches under `minGames` stay quiet.
 */
export function shareBeyondBinomialNoise(
  configuredShare: number,
  armGames: number,
  batchGames: number,
  minGames = AB_SHARE_MIN_GAMES,
  z = AB_SHARE_Z,
): boolean {
  if (!Number.isFinite(batchGames) || batchGames < minGames) return false;
  if (!Number.isFinite(armGames) || armGames < 0) return false;
  if (!Number.isFinite(configuredShare) || configuredShare < 0 || configuredShare > 1) return false;
  if (!Number.isFinite(z) || z < 0) return false;
  const realized = armGames / batchGames;
  const se = Math.sqrt((configuredShare * (1 - configuredShare)) / batchGames);
  const gap = Math.abs(realized - configuredShare);
  if (se === 0) return gap > 0;
  return gap > z * se;
}

function resolveRef(
  ref: string,
  hostEngine: EngineName,
  root: string,
  load: (configPath: string) => { configId: string; config?: { search?: { id?: string } } },
  prove: (configPath: string) => void,
): ResolvedRef {
  if (looksLikePath(ref)) {
    const abs = path.resolve(root, ref);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new Error(`--ab config file not found: ${ref}`);
    }
    return armFromFile(abs, hostEngine, load, prove);
  }
  if (isEngineRef(ref)) {
    const engine = parseEngine(ref);
    return {
      configId: ladderConfigId(engine),
      configHash: policyHash(ladderPolicy(engine)),
      configPath: null,
      engine,
    };
  }
  const found = findConfigFile(ref, root, load);
  if (!found) {
    throw new Error(`Unknown --ab config ${JSON.stringify(ref)}. Pass a yaml path, a config id, or an engine profile (search, exact, max-damage).`);
  }
  return armFromFile(found, hostEngine, load, prove);
}

function armFromFile(
  filePath: string,
  hostEngine: EngineName,
  load: (configPath: string) => { configId: string; config?: { search?: { id?: string } } },
  prove: (configPath: string) => void,
): ResolvedRef {
  const loaded = load(filePath);
  prove(filePath);
  return {
    configId: loaded.configId,
    configHash: loaded.configId,
    configPath: filePath,
    engine: loaded.config?.search?.id === 'max-damage' ? 'max-damage' : hostEngine,
  };
}

function looksLikePath(ref: string): boolean {
  return ref.includes('/') || ref.includes('\\') || /\.(ya?ml|json)$/i.test(ref);
}

function isEngineRef(ref: string): boolean {
  try {
    parseEngine(ref);
    return true;
  } catch {
    return false;
  }
}

function findConfigFile(
  configId: string,
  root: string,
  load: (configPath: string) => { configId: string; config?: { search?: { id?: string } } },
): string | null {
  const dir = path.join(root, 'configs');
  if (!fs.existsSync(dir)) return null;
  const files: string[] = [];
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (/\.(ya?ml|json)$/i.test(entry.name)) files.push(full);
    }
  };
  visit(dir);
  for (const file of files) {
    try {
      if (load(file).configId === configId) return file;
    } catch {
      // A file that does not parse is not this id.
    }
  }
  return null;
}
