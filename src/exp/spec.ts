import { z } from 'zod';
import { ENV_NAMES } from '../config/env.js';

export const ExperimentSpecSchema = z.object({
  id: z.string().min(1),
  challenger: z.string().optional(),
  base: z.string().optional(),
  opponent: z.string().optional(),
  panel: z.array(z.string()).default(['configs/panel/random.yaml']),
  games: z.number().int().positive().default(4),
  seedStart: z.number().int().default(1),
  costCapUsd: z.number().nonnegative().default(0),
  env: z.enum(ENV_NAMES).default('gate'),
  method: z.enum(['grid', 'successive-halving']).optional(),
  axes: z.array(z.object({
    path: z.string().min(1),
    values: z.array(z.union([z.string(), z.number(), z.boolean()])),
  }).strict()).optional(),
  devWeight: z.number().nonnegative().default(1),
}).strict();

export type ExperimentSpec = z.infer<typeof ExperimentSpecSchema>;
