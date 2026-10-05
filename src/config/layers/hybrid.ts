import { register } from '../registry.js';
import { HybridParamsSchema, type HybridParams } from '../schema.js';

/** Toggle block for the sampled-world search and its LLM layers. */
export function registerHybrid(): void {
  register<HybridParams>({
    layer: 'hybrid',
    id: 'layers',
    schema: HybridParamsSchema,
    defaults: HybridParamsSchema.parse({}),
    create: params => params,
  });
}
