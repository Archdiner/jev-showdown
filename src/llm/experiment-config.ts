import * as fs from 'fs';
import { z } from 'zod';
import type { BlendConfig } from './types.js';

const ExperimentFile = z.object({
  id: z.string(),
  champion: z.object({
    useLLMPrior: z.literal(false),
    blendMode: z.literal('off'),
  }),
  challenger: z.object({
    useLLMPrior: z.literal(true),
    blendMode: z.enum(['prior', 'tiebreaker']),
    priorWeight: z.number().min(0).max(1),
    tieEpsilon: z.number().nonnegative(),
    topK: z.number().int().positive(),
    model: z.string(),
    degradeToPureSearch: z.literal(true),
  }),
});

export type JevPriorExperiment = z.infer<typeof ExperimentFile>;

export function loadJevPriorExperiment(path = 'experiments/llm-jev-prior/config.json'): JevPriorExperiment {
  return ExperimentFile.parse(JSON.parse(fs.readFileSync(path, 'utf8')));
}

export function challengerBlendConfig(experiment: JevPriorExperiment): BlendConfig {
  return {
    mode: experiment.challenger.blendMode,
    priorWeight: experiment.challenger.priorWeight,
    tieEpsilon: experiment.challenger.tieEpsilon,
    topK: experiment.challenger.topK,
  };
}
