/**
 * Model ids and per-token prices from GET https://ai-gateway.vercel.sh/v1/models
 * on 2026-10-04. Prices are USD per token, as published by the gateway
 * (decimal strings so the catalog value is exact).
 *
 * Reviewer default is the newest xAI Grok frontier language model.
 * Claude Opus 4.5 is not used.
 */

export interface TokenPricing {
  /** USD per input token. */
  input: string;
  /** USD per output token. */
  output: string;
  /** USD per cached input token, when the gateway publishes one. */
  inputCacheRead?: string;
  longContext?: {
    thresholdTokens: number;
    input: string;
    output: string;
  };
}

export interface CatalogModel {
  id: string;
  provider: string;
  name: string;
  released: string;
  type: 'language' | 'evaluation';
  pricing: TokenPricing;
  role: 'advisor' | 'reviewer-default' | 'reviewer-alternative';
}

export const JEV_MODEL_ID = 'typesafe-ai/jev';

/** Newest Grok frontier language model on the gateway as of 2026-10-04. */
export const DEFAULT_REVIEWER_MODEL_ID = 'spacexai/grok-4.7';

export const CATALOG: CatalogModel[] = [
  {
    id: JEV_MODEL_ID,
    provider: 'typesafe-ai',
    name: 'Jev',
    released: '2026-09-15',
    type: 'evaluation',
    role: 'advisor',
    pricing: { input: '0.000000042', output: '0' },
  },
  {
    id: DEFAULT_REVIEWER_MODEL_ID,
    provider: 'spacexai',
    name: 'Grok 4.7',
    released: '2026-09-21',
    type: 'language',
    role: 'reviewer-default',
    pricing: {
      input: '0.000002',
      output: '0.000006',
      inputCacheRead: '0.0000005',
      longContext: {
        thresholdTokens: 200001,
        input: '0.000004',
        output: '0.000012',
      },
    },
  },
  {
    id: 'anthropic/claude-opus-5.5',
    provider: 'anthropic',
    name: 'Claude Opus 5.5',
    released: '2026-09-22',
    type: 'language',
    role: 'reviewer-alternative',
    pricing: { input: '0.000004', output: '0.00002' },
  },
  {
    id: 'openai/gpt-6.1-sol',
    provider: 'openai',
    name: 'GPT-6.1 Sol',
    released: '2026-09-29',
    type: 'language',
    role: 'reviewer-alternative',
    pricing: { input: '0.000002', output: '0.00001' },
  },
];

export function catalogModel(id: string): CatalogModel | undefined {
  return CATALOG.find(model => model.id === id);
}

export function resolveReviewerModel(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.LOSS_REVIEWER_MODEL?.trim();
  return configured || DEFAULT_REVIEWER_MODEL_ID;
}

/** USD cost from token counts and catalog per-token rates. */
export function estimateCostUsd(modelId: string, inputTokens: number, outputTokens: number): number {
  const model = catalogModel(modelId);
  if (!model) return 0;
  const inputRate = Number(model.pricing.input);
  const outputRate = Number(model.pricing.output);
  return inputTokens * inputRate + outputTokens * outputRate;
}
