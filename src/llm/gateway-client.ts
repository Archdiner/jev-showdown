import { estimateCostUsd } from './models.js';

export interface GatewayConfig {
  endpoint?: string;
  apiKey?: string;
  /** Per-request timeout cap, in milliseconds. */
  timeoutMs?: number;
  /** Extra attempts after the first failure. */
  maxRetries?: number;
  /** Hard ceiling for all LLM time inside one battle turn. */
  perTurnLatencyBudgetMs?: number;
  fetchImpl?: typeof fetch;
  /** Test hook. Production logging goes to console and never includes the key. */
  log?: (line: string) => void;
}

export interface CallMetrics {
  model: string;
  latencyMs: number;
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
  status: 'ok' | 'error';
  attempts: number;
}

type LlmObserver = (metrics: CallMetrics) => void;
const llmObservers: LlmObserver[] = [];

/** Fired after a gateway call returns. Observers must not throw or block the turn. */
export function observeLlmCalls(observer: LlmObserver): () => void {
  llmObservers.push(observer);
  return () => {
    const index = llmObservers.indexOf(observer);
    if (index >= 0) llmObservers.splice(index, 1);
  };
}

export function notifyLlmObservers(metrics: CallMetrics): void {
  for (const observer of llmObservers) {
    try {
      observer(metrics);
    } catch {
      // A metrics sink must not change the move.
    }
  }
}

export interface GatewaySuccess<T> {
  ok: true;
  data: T;
  metrics: CallMetrics;
}

export interface GatewayFailure {
  ok: false;
  error: string;
  metrics: CallMetrics;
}

export type GatewayResult<T> = GatewaySuccess<T> | GatewayFailure;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonSchema?: Record<string, unknown>;
}

export type EvaluateQuestion =
  | {
      type: 'choice';
      instructions: string;
      /** Required. Option key -> description. */
      criteria: Record<string, string>;
    }
  | {
      type: 'score';
      instructions: string;
      /** Ordered lowest to highest. Two to ten labels. */
      criteria: string[];
    }
  | {
      type: 'boolean';
      instructions: string;
      criteria?: { true: string; false: string };
    };

export interface EvaluateRequest {
  model: string;
  /** Plain text. Jev rejects a non-string state and caps this at 32k tokens. */
  state: string;
  questions: Record<string, EvaluateQuestion>;
}

interface EvaluateAnswer {
  type?: string;
  choice?: string;
  score?: number;
  probability?: number;
  probabilities?: Record<string, number>;
}

export interface EvaluateResponse {
  model: string;
  answers: Record<string, EvaluateAnswer>;
  usage?: { inputTokens?: number; outputTokens?: number };
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

/** Process-wide. A free-tier 403 must not be retried or logged on every turn. */
const restrictedModels = new Set<string>();

export function resetRestrictionLatch(): void {
  restrictedModels.clear();
}

export class GatewayClient {
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly perTurnLatencyBudgetMs: number;

  #apiKey?: string;
  #fetch: typeof fetch;
  #log: (line: string) => void;
  #turnActive = false;
  #usedMs = 0;

  constructor(config: GatewayConfig = {}) {
    this.endpoint = (config.endpoint || 'https://ai-gateway.vercel.sh/v1').replace(/\/$/, '');
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.maxRetries = config.maxRetries ?? 2;
    this.perTurnLatencyBudgetMs = config.perTurnLatencyBudgetMs ?? 1500;
    this.#apiKey = config.apiKey ?? process.env.VERCEL_AI_GATEWAY_KEY ?? process.env.AI_GATEWAY_API_KEY;
    this.#fetch = config.fetchImpl ?? fetch;
    this.#log = config.log ?? (line => console.log(line));
  }

  hasApiKey(): boolean {
    return !!this.#apiKey;
  }

  /** Share one latency budget across every call until the next turn. */
  startTurn(): void {
    this.#turnActive = true;
    this.#usedMs = 0;
  }

  endTurn(): void {
    this.#turnActive = false;
    this.#usedMs = 0;
  }

  remainingBudgetMs(): number {
    if (!this.#turnActive) return this.perTurnLatencyBudgetMs;
    return Math.max(0, this.perTurnLatencyBudgetMs - this.#usedMs);
  }

  async listModels(): Promise<GatewayResult<unknown>> {
    return this.request('GET', '/models', undefined, 'catalog');
  }

  async chat(request: ChatRequest): Promise<GatewayResult<string>> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature ?? 0,
    };
    if (request.maxTokens) body.max_tokens = request.maxTokens;
    if (request.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'response',
          strict: true,
          schema: request.jsonSchema,
        },
      };
    }

    const result = await this.request<any>('POST', '/chat/completions', body, request.model);
    if (!result.ok) return result;

    const content = result.data?.choices?.[0]?.message?.content;
    if (content == null) {
      return {
        ok: false,
        error: 'No content in chat response',
        metrics: { ...result.metrics, status: 'error' },
      };
    }
    return {
      ok: true,
      data: typeof content === 'string' ? content : JSON.stringify(content),
      metrics: result.metrics,
    };
  }

  async evaluate(request: EvaluateRequest): Promise<GatewayResult<EvaluateResponse>> {
    const invalid = validateEvaluation(request);
    if (invalid) {
      const metrics = this.metrics(request.model, 0, 0, 0, 0, 'error', 0);
      return { ok: false, error: invalid, metrics };
    }

    const result = await this.request<EvaluateResponse>(
      'POST',
      '/evaluate',
      {
        model: request.model,
        state: request.state,
        questions: request.questions,
      },
      request.model
    );
    if (!result.ok) return result;
    if (!result.data?.answers) {
      return {
        ok: false,
        error: 'Evaluation response missing answers',
        metrics: { ...result.metrics, status: 'error' },
      };
    }
    return result;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    model: string
  ): Promise<GatewayResult<T>> {
    const started = Date.now();
    if (restrictedModels.has(model)) {
      const metrics = this.metrics(model, 0, 0, 0, 0, 'error', 0);
      return { ok: false, error: 'restricted_model', metrics };
    }

    if (!this.#apiKey) {
      const metrics = this.metrics(model, 0, 0, 0, 0, 'error', 0);
      return { ok: false, error: 'missing_api_key', metrics };
    }

    if (this.remainingBudgetMs() <= 0) {
      const metrics = this.metrics(model, 0, 0, 0, 0, 'error', 0);
      this.emit(metrics);
      return { ok: false, error: 'latency_budget_exceeded', metrics };
    }

    let lastError = 'request_failed';
    let attempts = 0;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const budget = this.remainingBudgetMs();
      if (budget <= 0) {
        lastError = 'latency_budget_exceeded';
        break;
      }

      attempts++;
      const timeoutMs = Math.min(this.timeoutMs, budget);
      const attemptStarted = Date.now();
      try {
        const response = await this.#fetch(`${this.endpoint}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            'Content-Type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const elapsed = Date.now() - attemptStarted;
        this.charge(elapsed);

        const text = await response.text();
        if (!response.ok) {
          if (isRestrictedResponse(response.status, text)) {
            const first = !restrictedModels.has(model);
            restrictedModels.add(model);
            const metrics = this.metrics(model, Date.now() - started, 0, 0, 0, 'error', attempts);
            if (first) {
              this.#log(`[llm] model=${model} 403 RestrictedModelsError; falling back to pure search`);
            }
            return { ok: false, error: 'restricted_model', metrics };
          }

          lastError = `http_${response.status}`;
          if (RETRYABLE.has(response.status) && attempt < this.maxRetries && this.remainingBudgetMs() > 0) {
            await this.backoff(attempt);
            continue;
          }
          const metrics = this.metrics(model, Date.now() - started, 0, 0, 0, 'error', attempts);
          this.emit(metrics);
          return { ok: false, error: this.redact(`${lastError}: ${text.slice(0, 300)}`), metrics };
        }

        const parsed = text ? JSON.parse(text) : {};
        const usage = readUsage(parsed);
        const cost = readCost(parsed, model, usage.input, usage.output);
        const metrics = this.metrics(model, Date.now() - started, usage.input, usage.output, cost, 'ok', attempts);
        this.emit(metrics);
        return { ok: true, data: parsed as T, metrics };
      } catch (error) {
        const elapsed = Date.now() - attemptStarted;
        this.charge(elapsed);
        const aborted = isAbort(error);
        const message = error instanceof Error ? error.message : 'network_error';
        lastError = aborted ? 'timeout' : this.redact(message);
        if (!aborted && attempt < this.maxRetries && this.remainingBudgetMs() > 0) {
          await this.backoff(attempt);
          continue;
        }
        break;
      }
    }

    const metrics = this.metrics(model, Date.now() - started, 0, 0, 0, 'error', attempts);
    this.emit(metrics);
    return { ok: false, error: this.redact(lastError), metrics };
  }

  private charge(ms: number): void {
    if (this.#turnActive) this.#usedMs += ms;
  }

  private async backoff(attempt: number): Promise<void> {
    const delay = Math.min(200 * 2 ** attempt, this.remainingBudgetMs());
    if (delay <= 0) return;
    await new Promise(resolve => setTimeout(resolve, delay));
    this.charge(delay);
  }

  private redact(text: string): string {
    if (!this.#apiKey) return text;
    return text.split(this.#apiKey).join('[redacted]');
  }

  private emit(metrics: CallMetrics): void {
    this.#log(
      `[llm] model=${metrics.model} latency_ms=${metrics.latencyMs} ` +
        `tokens_in=${metrics.tokensInput} tokens_out=${metrics.tokensOutput} ` +
        `cost_usd=${metrics.costUsd.toFixed(8)} status=${metrics.status} attempts=${metrics.attempts}`
    );
    notifyLlmObservers(metrics);
  }

  private metrics(
    model: string,
    latencyMs: number,
    tokensInput: number,
    tokensOutput: number,
    costUsd: number,
    status: 'ok' | 'error',
    attempts: number
  ): CallMetrics {
    return { model, latencyMs, tokensInput, tokensOutput, costUsd, status, attempts };
  }
}

function readUsage(payload: any): { input: number; output: number } {
  const usage = payload?.usage ?? {};
  return {
    input: numberOrZero(usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens),
    output: numberOrZero(usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens),
  };
}

function readCost(payload: any, model: string, input: number, output: number): number {
  const gatewayCost = payload?.providerMetadata?.gateway?.cost;
  if (gatewayCost != null && gatewayCost !== '' && !Number.isNaN(Number(gatewayCost))) {
    return Number(gatewayCost);
  }
  return estimateCostUsd(model, input, output);
}

function numberOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function isRestrictedResponse(status: number, body: string): boolean {
  return status === 403 && /RestrictedModelsError|restricted model/i.test(body);
}

function validateEvaluation(request: EvaluateRequest): string | null {
  if (typeof request.state !== 'string') return 'evaluation state must be a string';
  for (const [name, question] of Object.entries(request.questions)) {
    if (question.type === 'choice') {
      const criteria = question.criteria;
      if (!criteria || Array.isArray(criteria) || Object.keys(criteria).length === 0) {
        return `choice question ${name} requires a criteria record keyed by option`;
      }
    }
    if (question.type === 'score') {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10) {
        return `score question ${name} requires 2 to 10 ordered criteria labels`;
      }
    }
  }
  return null;
}
