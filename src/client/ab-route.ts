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

export const CHALLENGER_LOSS_STREAK = 4;

/** Shares are stored as millionths so 0.1 + 0.2 + 0.7 stays exact. */
const SHARE_UNITS = 1_000_000;

export type PullReason = 'invalid-move' | 'timer-loss' | 'crash' | 'loss-streak';

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
  /** Ghost room from a drain. It did not play, so it cannot pull a challenger. */
  phantom?: boolean;
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
 * Hash the battle id into the share buckets. A pulled challenger falls
 * through to the champion. The champion arm is never pulled.
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
  private readonly byBattle = new Map<string, AbAssignment>();
  private readonly noted = new Set<string>();
  readonly incidents: AbIncident[] = [];

  constructor(
    readonly plan: AbPlan,
    private readonly onIncident?: (incident: AbIncident) => void,
  ) {}

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

  /** An invalid move or an in-battle crash. Later games of that challenger play the champion. */
  noteFault(battleId: string, fault: 'invalid-move' | 'crash'): AbIncident | null {
    const assignment = this.byBattle.get(battleId);
    if (!assignment || assignment.role !== 'challenger' || assignment.redirected) return null;
    return this.pull(assignment, battleId, fault, this.streak.get(assignment.configId) ?? 0);
  }

  /** Game end. Invalid, our timer, and crash pull immediately. Four losses in a row pull once. */
  noteGame(game: AbGameFact): AbIncident | null {
    if (this.noted.has(game.battleId)) return null;
    this.noted.add(game.battleId);
    if (game.phantom) return null;
    if (game.role !== 'challenger' || !game.configId) return null;
    const assignment = this.assignmentFor(game);
    if (!assignment || assignment.redirected) return null;
    if (this.pulled.has(assignment.configId)) return null;

    if (game.invalidChoices > 0) {
      return this.pull(assignment, game.battleId, 'invalid-move', this.streak.get(assignment.configId) ?? 0);
    }
    if (game.crashes > 0 || game.endReason === 'crash') {
      return this.pull(assignment, game.battleId, 'crash', this.streak.get(assignment.configId) ?? 0);
    }
    if (game.endReason === 'our-timer') {
      return this.pull(assignment, game.battleId, 'timer-loss', this.streak.get(assignment.configId) ?? 0);
    }
    if (game.outcome !== 'loss') {
      this.streak.set(assignment.configId, 0);
      return null;
    }
    const streak = (this.streak.get(assignment.configId) ?? 0) + 1;
    this.streak.set(assignment.configId, streak);
    if (streak >= CHALLENGER_LOSS_STREAK) {
      return this.pull(assignment, game.battleId, 'loss-streak', streak);
    }
    return null;
  }

  private assignmentFor(game: AbGameFact): AbAssignment | null {
    const stored = this.byBattle.get(game.battleId);
    if (stored) return stored;
    const arm = this.plan.arms.find(item => item.configId === game.configId && item.role === 'challenger');
    if (!arm) return null;
    return { ...arm, redirected: false };
  }

  private pull(assignment: AbAssignment, battleId: string, reason: PullReason, streak: number): AbIncident | null {
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
      detail: pullDetail(reason, streak),
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

function pullDetail(reason: PullReason, streak: number): string {
  if (reason === 'loss-streak') return `${streak} losses in a row`;
  if (reason === 'invalid-move') return 'invalid move';
  if (reason === 'timer-loss') return 'timer loss';
  return 'crash';
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
