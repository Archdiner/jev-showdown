import * as fs from 'fs';
import type { EnvName } from './env.js';
import type { BotSpec } from './interfaces.js';
import { loadConfig, resolveRaw, toSpec } from './load.js';
import type { RawConfig } from './schema.js';

const FILES: Record<string, string> = {
  random: 'configs/panel/random.yaml',
  'random-v1': 'configs/panel/random.yaml',
  maxdamage: 'configs/panel/maxdamage.yaml',
  'maxdamage-v1': 'configs/panel/maxdamage.yaml',
  exact: 'configs/champion.yaml',
  'exact-1ply': 'configs/champion.yaml',
  'challenger-exact-1ply': 'configs/champion.yaml',
  champion: 'configs/champion.yaml',
  'exact-1ply-qw': 'configs/exact-1ply-qw.yaml',
  qw: 'configs/exact-1ply-qw.yaml',
  'fitted-1ply': 'configs/fitted-1ply.yaml',
  fitted: 'configs/fitted-1ply.yaml',
  legacy: 'configs/examples/search-legacy.yaml',
  'champion-v0': 'configs/examples/search-legacy.yaml',
  mcts: 'configs/examples/search-mcts-stub.yaml',
  simple1ply: 'configs/champion.yaml',
  robust: 'configs/champion.yaml',
};

export function specForAlias(id: string, env: EnvName = 'selfplay'): BotSpec {
  if (id.endsWith('.yaml') || id.endsWith('.yml') || id.endsWith('.json') || id.includes('/') || id.includes('\\')) {
    return toSpec(loadConfig(id), env);
  }
  if (id.startsWith('exact:') || id.startsWith('exact,')) {
    return toSpec(resolveRaw(exactRaw(id), id), env);
  }
  const file = FILES[id] ?? guessConfigFile(id);
  if (!file) throw new Error(`Unknown bot id "${id}". Pass a config path under configs/.`);
  return toSpec(loadConfig(file), env);
}

function guessConfigFile(id: string): string | null {
  const candidates = [
    `configs/${id}.yaml`,
    `configs/${id}.yml`,
    `configs/panel/${id}.yaml`,
    `configs/examples/${id}.yaml`,
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function exactRaw(id: string): RawConfig {
  const body = id.replace(/^exact[:,]?/, '');
  const [depth, model, evalMode] = body.split(/[:,]/);
  const opponent = model === 'uniform' ? 'uniform' : 'max-damage';
  return {
    name: id,
    agent: { id: 'balanced' },
    search: {
      id: 'depth-n',
      params: {
        depth: Number(depth) || 1,
        opponentModel: opponent,
        evalMode: evalMode === 'full' ? 'full' : 'hp',
        risk: 'expected-value',
      },
    },
    evaluator: { id: evalMode === 'full' ? 'legacy-full' : 'hp-fraction' },
    opponentModel: { behavior: { id: opponent } },
  };
}
