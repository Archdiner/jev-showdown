import type { BlendConfig, BlendMode } from '../../llm/types.js';
import { register } from '../registry.js';
import { AdvisorParamsSchema, type AdvisorParams } from '../schema.js';

export interface AdvisorImpl {
  id: string;
  params: AdvisorParams;
  blendConfig(): BlendConfig;
}

export function registerAdvisor(): void {
  register<AdvisorParams>({
    layer: 'advisor',
    id: 'jev',
    schema: AdvisorParamsSchema,
    defaults: AdvisorParamsSchema.parse({}),
    create: params => ({
      id: 'jev',
      params,
      blendConfig(): BlendConfig {
        return {
          mode: toBlendMode(params.blend),
          priorWeight: params.weight,
          tieEpsilon: params.tieEpsilon,
          topK: params.topK,
          blunderThreshold: params.blunderThreshold,
        };
      },
    }),
  });
}

function toBlendMode(mode: AdvisorParams['blend']): BlendMode {
  if (mode === 'tiebreak') return 'tiebreaker';
  return mode;
}
