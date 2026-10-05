import * as fs from 'fs';
import * as path from 'path';
import { buildBot } from '../config/bot.js';
import { loadConfig } from '../config/load.js';
import { GraphDB } from '../graph/db.js';
import { currentGitSha } from './game-record.js';
import { EngineName } from './engines.js';
import { ladderConfigId, ladderPolicy, policyHash } from './ladder-engine.js';

/**
 * The config that will play every game in this process.
 * Resolved once at batch start. A later promotion does not change it.
 */
export interface LadderIdentity {
  source: 'builtin' | 'labeled-champion' | 'rollback';
  configId: string;
  configHash: string;
  gitSha: string | null;
  configPath: string | null;
  engine: EngineName;
  /** Set only when this batch plays the labeled file. Workers load it at init. */
  championConfigPath: string | null;
  reason: string | null;
}

export interface ChampionLabel {
  configId: string;
  configPath: string;
}

export interface ResolveLadderIdentityInput {
  engine: EngineName;
  /** Explicit opt-in. Off leaves the builtin policy in place. */
  labeledChampion: boolean;
  /** Operator forces the builtin policy for this batch. */
  rollback: boolean;
  gitSha?: string | null;
  graphPath?: string;
  readChampions?: (graphPath: string) => ChampionLabel[];
  load?: (configPath: string) => { configId: string };
  prove?: (configPath: string) => void;
}

const DEFAULT_GRAPH = path.join(process.cwd(), 'state', 'graph.db');

export function graphPathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.GRAPH_DB?.trim() || DEFAULT_GRAPH;
}

/** Active gatekeeper champion labels. Does not write the graph. */
export function readActiveChampions(graphPath: string): ChampionLabel[] {
  if (!fs.existsSync(graphPath)) return [];
  const db = new GraphDB(graphPath);
  try {
    const labels: ChampionLabel[] = [];
    for (const node of db.getNodesByType('Champion', 'active')) {
      const meta = (node.metadata ?? {}) as { configId?: string };
      const configPath = (node as { config_path?: string }).config_path || '';
      const configId = meta.configId || (node as { version?: string }).version || '';
      if (!configId || !configPath) continue;
      labels.push({ configId, configPath });
    }
    return labels;
  } finally {
    db.close();
  }
}

export function builtinIdentity(engine: EngineName, gitSha: string | null): LadderIdentity {
  return Object.freeze({
    source: 'builtin',
    configId: ladderConfigId(engine),
    configHash: policyHash(ladderPolicy(engine)),
    gitSha,
    configPath: null,
    engine,
    championConfigPath: null,
    reason: null,
  });
}

function rolledBack(engine: EngineName, gitSha: string | null, reason: string): LadderIdentity {
  return { ...builtinIdentity(engine, gitSha), source: 'rollback', reason };
}

/**
 * Pick the config for one batch. Reads the graph at most once.
 * The returned object is frozen so a later write cannot retarget the batch.
 */
export function resolveLadderIdentity(input: ResolveLadderIdentityInput): LadderIdentity {
  const gitSha = input.gitSha === undefined ? currentGitSha() : input.gitSha;
  const builtin = builtinIdentity(input.engine, gitSha);
  if (input.rollback) {
    return Object.freeze(rolledBack(input.engine, gitSha, 'operator rollback'));
  }
  if (!input.labeledChampion) return Object.freeze(builtin);

  const graphPath = input.graphPath ?? graphPathFromEnv();
  const read = input.readChampions ?? readActiveChampions;
  const load = input.load ?? ((configPath: string) => loadConfig(configPath));
  const prove = input.prove ?? ((configPath: string) => {
    buildBot(configPath, 'ladder');
  });

  let labels: ChampionLabel[];
  try {
    labels = read(graphPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Object.freeze(rolledBack(input.engine, gitSha, `could not read champion labels: ${message}`));
  }
  if (labels.length === 0) {
    return Object.freeze(rolledBack(input.engine, gitSha, 'no active champion label'));
  }
  if (labels.length > 1) {
    const ids = labels.map(label => label.configId).join(',');
    return Object.freeze(rolledBack(input.engine, gitSha, `more than one active champion (${ids})`));
  }

  const label = labels[0];
  let loaded: { configId: string };
  try {
    loaded = load(label.configPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Object.freeze(rolledBack(
      input.engine,
      gitSha,
      `could not load ${label.configPath}: ${message}`,
    ));
  }
  if (loaded.configId !== label.configId) {
    return Object.freeze(rolledBack(
      input.engine,
      gitSha,
      `champion file hash ${loaded.configId} does not match label ${label.configId}`,
    ));
  }
  try {
    prove(label.configPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Object.freeze(rolledBack(input.engine, gitSha, `champion config failed to build: ${message}`));
  }

  return Object.freeze({
    source: 'labeled-champion',
    configId: label.configId,
    configHash: loaded.configId,
    gitSha,
    configPath: label.configPath,
    engine: input.engine,
    championConfigPath: label.configPath,
    reason: null,
  });
}

/** One line for the operator. Printed once, before the first search. */
export function formatLiveConfig(identity: LadderIdentity): string {
  const commit = identity.gitSha ?? 'unknown';
  const file = identity.configPath ? ` path=${identity.configPath}` : '';
  const reason = identity.reason ? ` reason=${JSON.stringify(identity.reason)}` : '';
  return `[ladder] config live source=${identity.source} id=${identity.configId} hash=${identity.configHash} commit=${commit}${file}${reason}`;
}
