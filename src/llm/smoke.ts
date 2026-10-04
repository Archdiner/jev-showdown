import { GatewayClient } from './gateway-client.js';
import { JEV_MODEL_ID, resolveReviewerModel } from './models.js';

/**
 * One live call to Jev and one live call to the reviewer.
 * Skips cleanly when VERCEL_AI_GATEWAY_KEY is unset. Never prints the key.
 */
async function main(): Promise<void> {
  if (!process.env.VERCEL_AI_GATEWAY_KEY) {
    console.log('SMOKE_SKIPPED reason=missing_VERCEL_AI_GATEWAY_KEY');
    return;
  }

  const client = new GatewayClient({ maxRetries: 0, perTurnLatencyBudgetMs: 20000, timeoutMs: 20000 });
  const reviewerModel = resolveReviewerModel();
  let failed = false;

  client.startTurn();
  const jev = await client.evaluate({
    model: JEV_MODEL_ID,
    state: 'Gen 9 Random Battle smoke test. Both sides are at full HP on turn 1.',
    questions: {
      ping: { type: 'boolean', instructions: 'Is this a connectivity smoke test?' },
    },
  });
  console.log(
    `SMOKE jev model=${JEV_MODEL_ID} ok=${jev.ok} latency_ms=${jev.metrics.latencyMs} cost_usd=${jev.metrics.costUsd.toFixed(8)}` +
      (jev.ok ? '' : ` error=${jev.error}`)
  );
  if (!jev.ok) failed = true;

  client.startTurn();
  const review = await client.chat({
    model: reviewerModel,
    maxTokens: 16,
    messages: [{ role: 'user', content: 'Reply with the single word pong.' }],
  });
  console.log(
    `SMOKE reviewer model=${reviewerModel} ok=${review.ok} latency_ms=${review.metrics.latencyMs} cost_usd=${review.metrics.costUsd.toFixed(8)}` +
      (review.ok ? '' : ` error=${review.error}`)
  );
  if (!review.ok) failed = true;

  if (failed) process.exitCode = 1;
}

main().catch(error => {
  const message = error instanceof Error ? error.message : 'smoke_failed';
  console.error(`SMOKE_FAILED ${message}`);
  process.exitCode = 1;
});
