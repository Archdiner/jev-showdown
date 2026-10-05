import { observeLlmCalls, type CallMetrics } from '../llm/gateway-client.js';
import type { LadderGameRecord } from './game-record.js';

/**
 * Optional mirror of ladder game rows and LLM call metrics.
 * JSONL remains the source of truth. Nothing here is awaited by a turn.
 * Off unless POSTHOG_API_KEY is set.
 */
const QUEUE_LIMIT = 200;

interface QueuedEvent {
  event: string;
  distinctId: string;
  properties: Record<string, unknown>;
}

export class PosthogSink {
  private queue: QueuedEvent[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly host: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  captureGame(record: LadderGameRecord): void {
    const properties: Record<string, unknown> = { ...record };
    delete properties.localReplayPath;
    delete properties.logPath;
    delete properties.log;
    delete properties.inputLog;
    this.enqueue({
      event: 'ladder_game',
      distinctId: record.username || 'ladder',
      properties,
    });
  }

  /** Metrics only. Prompt text is not sent. */
  captureLlm(metrics: CallMetrics): void {
    this.enqueue({
      event: '$ai_generation',
      distinctId: 'llm',
      properties: {
        $ai_model: metrics.model,
        $ai_provider: 'vercel-ai-gateway',
        $ai_latency: metrics.latencyMs / 1000,
        $ai_input_tokens: metrics.tokensInput,
        $ai_output_tokens: metrics.tokensOutput,
        $ai_total_cost_usd: metrics.costUsd,
        $ai_is_error: metrics.status !== 'ok',
        $ai_span_name: 'jev',
      },
    });
  }

  enqueue(event: QueuedEvent): void {
    this.queue.push(event);
    if (this.queue.length > QUEUE_LIMIT) this.queue.splice(0, this.queue.length - QUEUE_LIMIT);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 0);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.queue.splice(0);
    if (batch.length === 0) return;
    try {
      await this.fetchImpl(`${this.host}/batch/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.apiKey,
          batch: batch.map(item => ({
            event: item.event,
            distinct_id: item.distinctId,
            properties: { ...item.properties, $lib: 'jev-showdown' },
          })),
        }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // Dropped events stay in the JSONL log.
    }
  }

  shutdown(): Promise<void> {
    return this.flush();
  }
}

let installed = false;
let sink: PosthogSink | null = null;

export function tracesEnabled(): boolean {
  const flag = process.env.POSTHOG_LLM_TRACES?.trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes';
}

export function posthogSinkFromEnv(fetchImpl?: typeof fetch): PosthogSink | null {
  const apiKey = process.env.POSTHOG_API_KEY?.trim();
  if (!apiKey) return null;
  const host = (process.env.POSTHOG_HOST?.trim() || 'https://us.i.posthog.com').replace(/\/$/, '');
  return new PosthogSink(apiKey, host, fetchImpl);
}

/** Idempotent. Returns null when POSTHOG_API_KEY is unset. Never throws. */
export function installPosthogSink(): PosthogSink | null {
  if (installed) return sink;
  installed = true;
  try {
    sink = posthogSinkFromEnv();
  } catch {
    sink = null;
    return null;
  }
  if (sink && tracesEnabled()) {
    observeLlmCalls(metrics => sink?.captureLlm(metrics));
  }
  return sink;
}

/** Test hook. Production calls install once per process. */
export function resetPosthogSinkForTests(): void {
  installed = false;
  sink = null;
}
