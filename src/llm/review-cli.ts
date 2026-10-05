import { GraphDB } from '../graph/db.js';
import { GatewayClient } from './gateway-client.js';
import { LossReviewer } from './loss-reviewer.js';
import { resolveReviewerModel } from './models.js';

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

async function main(): Promise<void> {
  const file = process.argv.slice(2).find(arg => !arg.startsWith('--'));
  if (!file) {
    console.error('Usage: review-cli <game.jsonl|replay> [--model=id] [--no-graph]');
    process.exitCode = 1;
    return;
  }

  const model = option('model') || resolveReviewerModel();
  const writeGraph = !process.argv.includes('--no-graph');
  const client = new GatewayClient();
  const reviewer = new LossReviewer(client, model);
  const db = writeGraph ? new GraphDB() : undefined;

  try {
    const result = await reviewer.reviewFile(file, { db, battleId: option('battle') });
    if (!result.ok) {
      console.error(`REVIEW_FAILED ${result.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ model: result.model, hypothesisId: result.hypothesisId, finding: result.finding, metrics: result.metrics }, null, 2));
  } finally {
    db?.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
