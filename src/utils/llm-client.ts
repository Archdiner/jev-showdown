import { LLMRequest, LLMResponse } from '../types/index.js';

export interface LLMConfig {
  endpoint: string;
  apiKey?: string;
  jevModel?: string;
  reasoningModel?: string;
}

export class LLMClient {
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = {
      jevModel: config.jevModel || 'typesafe-ai/jev',
      reasoningModel: config.reasoningModel || 'anthropic/claude-opus-5.5',
      endpoint: config.endpoint || 'https://ai-gateway.vercel.sh/v1',
      apiKey: config.apiKey,
    };
  }

  async queryJev(request: LLMRequest): Promise<LLMResponse> {
    if (!this.config.apiKey) {
      return this.mockResponse(request);
    }

    try {
      const response = await fetch(`${this.config.endpoint}/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.jevModel,
          state: request.state,
          question: request.question,
          choices: request.choices,
        }),
      });

      if (!response.ok) {
        console.warn('LLM API error:', response.status);
        return this.mockResponse(request);
      }

      const data = await response.json();
      return this.parseJevResponse(data);
    } catch (error) {
      console.warn('LLM query failed:', error);
      return this.mockResponse(request);
    }
  }

  async analyzeLoss(
    battleLog: string,
    decisions: any[],
    outcome: string
  ): Promise<string> {
    if (!this.config.apiKey) {
      return 'LLM analysis not available (no API key)';
    }

    try {
      const response = await fetch(`${this.config.endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.reasoningModel,
          messages: [
            {
              role: 'system',
              content: 'You are an expert Pokemon battler analyzing game logs to identify mistakes and suggest improvements.',
            },
            {
              role: 'user',
              content: `Analyze this Pokemon Showdown battle loss and identify key mistakes:\n\nBattle Log:\n${battleLog.slice(0, 5000)}\n\nProvide specific turn numbers and suggest what should have been done differently.`,
            },
          ],
          max_tokens: 1000,
        }),
      });

      if (!response.ok) {
        return `Analysis failed: HTTP ${response.status}`;
      }

      const data = await response.json() as any;
      return data.choices?.[0]?.message?.content || 'No analysis generated';
    } catch (error) {
      return `Analysis error: ${error}`;
    }
  }

  private parseJevResponse(data: any): LLMResponse {
    return {
      choice: data.choice,
      scores: data.scores || {},
      probabilities: data.probabilities || {},
      reasoning: data.reasoning,
    };
  }

  private mockResponse(request: LLMRequest): LLMResponse {
    const scores: Record<string, number> = {};
    
    if (request.choices) {
      for (const choice of request.choices) {
        scores[choice] = Math.random();
      }
    }

    return {
      scores,
      probabilities: scores,
      reasoning: 'Mock response (no API key)',
    };
  }

  hasApiKey(): boolean {
    return !!this.config.apiKey;
  }
}

export function createLLMClient(): LLMClient {
  const apiKey = 
    process.env.AI_GATEWAY_API_KEY || 
    process.env.VERCEL_AI_GATEWAY_KEY;

  return new LLMClient({
    endpoint: 'https://ai-gateway.vercel.sh/v1',
    apiKey,
  });
}
