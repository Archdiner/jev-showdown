import { LLMRequest, LLMResponse } from '../types/index.js';
import { GatewayClient } from '../llm/gateway-client.js';
import { JevAdvisor } from '../llm/jev-advisor.js';
import { LossReviewer } from '../llm/loss-reviewer.js';
import { JEV_MODEL_ID, resolveReviewerModel } from '../llm/models.js';
import type { CompactStateSummary } from '../llm/types.js';

export interface LLMConfig {
  endpoint?: string;
  apiKey?: string;
  jevModel?: string;
  reasoningModel?: string;
}

/**
 * Compatibility wrapper around the LLM layer.
 * Jev advises; the loss reviewer is a separate, configurable frontier model.
 */
export class LLMClient {
  private gateway: GatewayClient;
  private jev: JevAdvisor;
  private reviewer: LossReviewer;

  constructor(config: LLMConfig = {}) {
    this.gateway = new GatewayClient({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
    });
    this.jev = new JevAdvisor(this.gateway, config.jevModel || JEV_MODEL_ID);
    this.reviewer = new LossReviewer(this.gateway, config.reasoningModel || resolveReviewerModel());
  }

  async queryJev(request: LLMRequest): Promise<LLMResponse> {
    const choices = request.choices ?? [];
    const summary: CompactStateSummary = isSummary(request.state)
      ? request.state
      : {
          turn: 0,
          player: 'unknown',
          field: { trickRoom: false, screens: {} },
          hazards: {
            my: { stealthRock: false, spikes: 0, toxicSpikes: 0 },
            opponent: { stealthRock: false, spikes: 0, toxicSpikes: 0 },
          },
          myActive: null,
          opponentActive: null,
          myBench: [],
          opponentBench: [],
          teraUsed: { mine: false, opponent: false },
        };

    const assessment = await this.jev.advise(
      summary,
      choices.map((choice, index) => ({
        id: `a${index}`,
        label: choice,
        action: { type: 'move', moveIndex: index + 1 },
        searchScore: 0,
      }))
    );

    if (assessment.degraded) {
      return {
        scores: {},
        probabilities: {},
        reasoning: assessment.reason || 'degraded to pure search',
      };
    }

    const scores: Record<string, number> = {};
    const probabilities: Record<string, number> = {};
    choices.forEach((choice, index) => {
      scores[choice] = assessment.scores[`a${index}`] ?? 0;
      probabilities[choice] = assessment.probabilities[`a${index}`] ?? 0;
    });
    const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0];
    return { choice, scores, probabilities };
  }

  async analyzeLoss(battleLog: string, _decisions: unknown[], _outcome: string): Promise<string> {
    const result = await this.reviewer.review(battleLog);
    if (!result.ok) return `Analysis unavailable: ${result.error}`;
    return JSON.stringify(result.finding);
  }

  hasApiKey(): boolean {
    return this.gateway.hasApiKey();
  }
}

export function createLLMClient(): LLMClient {
  return new LLMClient({
    endpoint: 'https://ai-gateway.vercel.sh/v1',
    apiKey: process.env.VERCEL_AI_GATEWAY_KEY || process.env.AI_GATEWAY_API_KEY,
    reasoningModel: resolveReviewerModel(),
  });
}

function isSummary(value: unknown): value is CompactStateSummary {
  return !!value && typeof value === 'object' && 'turn' in value && 'field' in value && 'hazards' in value;
}
