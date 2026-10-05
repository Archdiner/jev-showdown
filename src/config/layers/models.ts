import { GatewayClient, type ChatMessage } from '../../llm/gateway-client.js';
import { JevAdvisor } from '../../llm/jev-advisor.js';
import { LossReviewer } from '../../llm/loss-reviewer.js';
import { JEV_MODEL_ID } from '../../llm/models.js';
import { register } from '../registry.js';
import { ModelsParamsSchema, defaultModelRoles, type ModelRole, type ModelsParams } from '../schema.js';

export interface ModelSpend {
  [role: string]: number;
}

export interface ModelsImpl {
  id: string;
  params: ModelsParams;
  advisor(client: GatewayClient): JevAdvisor;
  reviewer(client: GatewayClient): LossReviewer;
  cap(role: ModelRole, envCap: number): number;
  complete(
    client: GatewayClient,
    role: ModelRole,
    messages: ChatMessage[],
    spend: ModelSpend,
    envCap: number
  ): Promise<{ text: string; model: string; costUsd: number } | null>;
}

export function registerModels(): void {
  register<ModelsParams>({
    layer: 'models',
    id: 'catalog',
    schema: ModelsParamsSchema,
    defaults: { roles: defaultModelRoles() },
    create: params => ({
      id: 'catalog',
      params,
      advisor(client: GatewayClient) {
        return new JevAdvisor(client, params.roles.turnAdvisor.models[0] || JEV_MODEL_ID);
      },
      reviewer(client: GatewayClient) {
        return new LossReviewer(client, params.roles.lossReviewer.models[0]);
      },
      cap(role: ModelRole, envCap: number) {
        return Math.min(params.roles[role].costCapUsd, envCap);
      },
      async complete(client: GatewayClient, role: ModelRole, messages: ChatMessage[], spend: ModelSpend, envCap: number) {
        const cap = Math.min(params.roles[role].costCapUsd, envCap);
        let spent = spend[role] || 0;
        for (const model of params.roles[role].models) {
          if (spent >= cap) return null;
          const result = await client.chat({ model, messages, temperature: 0, maxTokens: 500 });
          spent += result.metrics.costUsd;
          spend[role] = spent;
          if (result.ok) return { text: result.data, model, costUsd: result.metrics.costUsd };
        }
        return null;
      },
    }),
  });
}
