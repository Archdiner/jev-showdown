#!/usr/bin/env node

import { BattleLogger } from '../learning/battle-logger.js';
import { createLLMClient } from '../utils/llm-client.js';

async function main() {
  const logger = new BattleLogger();
  const llmClient = createLLMClient();

  if (!llmClient.hasApiKey()) {
    console.log('Warning: No LLM API key found. Set AI_GATEWAY_API_KEY or VERCEL_AI_GATEWAY_KEY');
    console.log('Analysis will be limited.\n');
  }

  const losses = logger.getLosses(10);
  console.log(`Found ${losses.length} recent losses\n`);

  for (let i = 0; i < losses.length; i++) {
    const battle = losses[i];
    console.log(`\n=== Loss ${i + 1}: ${battle.id} ===`);
    console.log(`Opponent: ${battle.opponent}`);
    console.log(`Turns: ${battle.turns}`);
    console.log(`Timestamp: ${new Date(battle.timestamp).toISOString()}`);

    if (llmClient.hasApiKey()) {
      console.log('\nAnalyzing...');
      const analysis = await llmClient.analyzeLoss(
        battle.log,
        battle.decisions,
        'loss'
      );
      console.log(analysis);
    } else {
      console.log('\nKey decisions:');
      const keyDecisions = battle.decisions.slice(-5);
      for (const decision of keyDecisions) {
        console.log(`Turn ${decision.turn}: ${JSON.stringify(decision.action)}`);
        console.log(`  Evaluation: ${decision.evaluation.score.toFixed(2)}`);
      }
    }
  }

  const stats = logger.getWinRate();
  console.log('\n=== Overall Statistics ===');
  console.log(`Wins: ${stats.wins}`);
  console.log(`Losses: ${stats.losses}`);
  console.log(`Ties: ${stats.ties}`);
  console.log(`Win Rate: ${(stats.winRate * 100).toFixed(2)}%`);

  logger.close();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
