import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { agentBundle } from './defaults.js';
import { configIdOf } from './hash.js';
import type { BotSpec, LayerIds } from './interfaces.js';
import { ensureLayers } from './layers/index.js';
import { deepMerge } from './merge.js';
import { parseParams } from './registry.js';
import {
  RawConfigSchema,
  type RawConfig,
  type ResolvedConfig,
} from './schema.js';
import { assertGeneralValue } from './specificity.js';

export interface LoadedConfig {
  configId: string;
  config: ResolvedConfig;
}

export function loadRaw(filePath: string, stack: string[] = []): RawConfig {
  const abs = path.resolve(filePath);
  if (stack.includes(abs)) throw new Error(`extends cycle at ${abs}`);
  const text = fs.readFileSync(abs, 'utf8');
  const parsed = abs.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  const raw = RawConfigSchema.parse(parsed ?? {});
  const parents = !raw.extends ? [] : Array.isArray(raw.extends) ? raw.extends : [raw.extends];
  let acc: RawConfig = {};
  for (const parent of parents) {
    acc = deepMerge(acc, loadRaw(path.resolve(path.dirname(abs), parent), [...stack, abs]));
  }
  const { extends: _ignored, ...own } = raw;
  return deepMerge(acc, own);
}

export function resolveRaw(raw: RawConfig, fallbackName = 'config'): LoadedConfig {
  ensureLayers();
  assertGeneralValue(raw, fallbackName);
  const agentId = raw.agent?.id ?? 'balanced';
  const merged = deepMerge(agentBundle(agentId), {
    ...raw,
    name: raw.name || fallbackName,
    agent: raw.agent ?? { id: agentId },
  });
  const config = materialize(merged, fallbackName);
  assertGeneralValue(config, config.name);
  return { configId: configIdOf(config), config };
}

export function loadConfig(filePath: string): LoadedConfig {
  return resolveRaw(loadRaw(filePath), path.basename(filePath).replace(/\.(ya?ml|json)$/i, ''));
}

export function isBotSpec(value: unknown): value is BotSpec {
  if (!value || typeof value !== 'object') return false;
  const spec = value as BotSpec;
  return typeof spec.configId === 'string' && Boolean(spec.config?.search?.id) && typeof spec.env === 'string';
}

export function toSpec(loaded: LoadedConfig, env: BotSpec['env']): BotSpec {
  return { configId: loaded.configId, config: loaded.config, env };
}

export function layerIdsOf(config: ResolvedConfig): LayerIds {
  return {
    agent: config.agent.id,
    search: config.search.id,
    evaluator: config.evaluator.id,
    setInference: config.opponentModel.setInference.id,
    behavior: config.opponentModel.behavior.id,
    teraPolicy: config.policies.teraPolicy.id,
    hazardPolicy: config.policies.hazardPolicy.id,
    sacPolicy: config.policies.sacPolicy.id,
    switchPolicy: config.policies.switchPolicy.id,
    leadPolicy: config.policies.leadPolicy.id,
    endgamePolicy: config.policies.endgamePolicy.id,
    context: config.context.id,
    advisor: config.advisor.id,
    models: config.models.id,
    metaController: config.metaController.id,
  };
}

function materialize(raw: RawConfig, fallbackName: string): ResolvedConfig {
  const policies = raw.policies ?? {};
  const opponent = raw.opponentModel ?? {};
  return {
    schemaVersion: 1,
    name: raw.name || fallbackName,
    agent: component('agent', raw.agent?.id ?? 'balanced', raw.agent?.params),
    search: component('search', raw.search?.id ?? 'greedy-1ply', raw.search?.params),
    evaluator: component('evaluator', raw.evaluator?.id ?? 'hp-fraction', raw.evaluator?.params),
    opponentModel: {
      setInference: component('setInference', opponent.setInference?.id ?? 'loose', opponent.setInference?.params),
      behavior: component('behavior', opponent.behavior?.id ?? 'max-damage', opponent.behavior?.params),
    },
    policies: {
      teraPolicy: component('teraPolicy', policies.teraPolicy?.id ?? 'off', policies.teraPolicy?.params),
      hazardPolicy: component('hazardPolicy', policies.hazardPolicy?.id ?? 'off', policies.hazardPolicy?.params),
      sacPolicy: component('sacPolicy', policies.sacPolicy?.id ?? 'off', policies.sacPolicy?.params),
      switchPolicy: component('switchPolicy', policies.switchPolicy?.id ?? 'off', policies.switchPolicy?.params),
      leadPolicy: component('leadPolicy', policies.leadPolicy?.id ?? 'off', policies.leadPolicy?.params),
      endgamePolicy: component('endgamePolicy', policies.endgamePolicy?.id ?? 'off', policies.endgamePolicy?.params),
    },
    context: component('context', raw.context?.id ?? 'blocks', raw.context?.params),
    advisor: component('advisor', raw.advisor?.id ?? 'jev', raw.advisor?.params),
    models: component('models', raw.models?.id ?? 'catalog', raw.models?.params),
    metaController: component('metaController', raw.metaController?.id ?? 'static', raw.metaController?.params),
  };
}

function component<P>(layer: string, id: string, params: unknown): { id: string; params: P } {
  return { id, params: parseParams<P>(layer, id, params) };
}
