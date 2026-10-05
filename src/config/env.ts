import { z } from 'zod';

export const ENV_NAMES = ['selfplay', 'gate', 'local', 'ladder'] as const;
export type EnvName = (typeof ENV_NAMES)[number];

export interface EnvProfile {
  name: EnvName;
  timeLimitMs: number;
  network: 'none' | 'loopback' | 'showdown';
  logSink: 'memory' | 'file' | 'graph';
  llm: {
    allowed: boolean;
    costCapUsd: number;
  };
}

/**
 * Operational caps only. These fields are not hashed into configId and must
 * not change search, weights, policies, or any other strategy layer.
 */
export const ENV_PROFILES: Record<EnvName, EnvProfile> = {
  selfplay: {
    name: 'selfplay',
    timeLimitMs: 2000,
    network: 'none',
    logSink: 'memory',
    llm: { allowed: false, costCapUsd: 0 },
  },
  gate: {
    name: 'gate',
    timeLimitMs: 2000,
    network: 'none',
    logSink: 'graph',
    llm: { allowed: false, costCapUsd: 0 },
  },
  local: {
    name: 'local',
    timeLimitMs: 5000,
    network: 'loopback',
    logSink: 'file',
    llm: { allowed: false, costCapUsd: 0 },
  },
  ladder: {
    name: 'ladder',
    timeLimitMs: 8000,
    network: 'showdown',
    logSink: 'file',
    llm: { allowed: true, costCapUsd: 1 },
  },
};

export const EnvSchema = z.object({
  name: z.enum(ENV_NAMES),
  timeLimitMs: z.number().positive(),
  network: z.enum(['none', 'loopback', 'showdown']),
  logSink: z.enum(['memory', 'file', 'graph']),
  llm: z.object({
    allowed: z.boolean(),
    costCapUsd: z.number().nonnegative(),
  }).strict(),
}).strict();

const STRATEGY_KEYS = [
  'agent', 'search', 'evaluator', 'opponentModel', 'policies',
  'context', 'advisor', 'models', 'metaController', 'extends',
];

export function assertEnvOnly(raw: unknown): EnvProfile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Env profile must be an object');
  }
  for (const key of STRATEGY_KEYS) {
    if (key in (raw as Record<string, unknown>)) {
      throw new Error(`Env profile cannot set strategy key "${key}"`);
    }
  }
  return EnvSchema.parse(raw);
}

export function resolveEnv(env: EnvName | EnvProfile = 'selfplay'): EnvProfile {
  if (typeof env === 'string') {
    const profile = ENV_PROFILES[env];
    if (!profile) throw new Error(`Unknown env "${env}"`);
    return profile;
  }
  return assertEnvOnly(env);
}
