#!/usr/bin/env node

import { BattleLogger } from '../learning/battle-logger.js';
import { GraphDB } from '../graph/db.js';
import { GatewayClient } from '../llm/gateway-client.js';
import { LossReviewer } from '../llm/loss-reviewer.js';
import { reviveGameState } from '../llm/battle-facts.js';
import { resolveReviewerModel } from '../llm/models.js';
import type { AdvisorCandidate } from '../llm/types.js';
import { dataLoader } from '../data/data-loader.js';

async function main() {
  const logger = new BattleLogger();
  const client = new GatewayClient();
  const reviewer = new LossReviewer(client, resolveReviewerModel());
  const graph = client.hasApiKey() ? new GraphDB() : undefined;

  if (!client.hasApiKey()) {
    console.log('Warning: No LLM API key found. Set VERCEL_AI_GATEWAY_KEY');
    console.log('Analysis will be limited.\n');
  } else {
    console.log(`Loss reviewer model: ${resolveReviewerModel()}`);
  }

  const losses = logger.getLosses(10);
  console.log(`Found ${losses.length} recent losses\n`);

  try {
    for (let i = 0; i < losses.length; i++) {
      const battle = losses[i];
      console.log(`\n=== Loss ${i + 1}: ${battle.id} ===`);
      console.log(`Opponent: ${battle.opponent}`);
      console.log(`Turns: ${battle.turns}`);
      console.log(`Timestamp: ${new Date(battle.timestamp).toISOString()}`);

      if (client.hasApiKey()) {
        const last = battle.decisions[battle.decisions.length - 1];
        const state = last ? reviveGameState(last.state) : undefined;
        const candidates: AdvisorCandidate[] = (last?.searchStats.topActions ?? []).map((entry, index) => ({
          id: `a${index}`,
          label: `${entry.action.type}`,
          action: entry.action,
          searchScore: entry.value,
        }));
        let pools = {};
        try {
          pools = dataLoader.getStats();
        } catch {
          pools = {};
        }
        const result = await reviewer.review(battle.log, {
          db: graph,
          battleId: battle.id,
          sourcePath: `battle:${battle.id}`,
          state,
          candidates,
          pools,
        });
        if (!result.ok) {
          console.log(`Review failed: ${result.error}`);
          continue;
        }
        console.log(`Hypothesis: ${result.hypothesisId}`);
        console.log(`Critical turn: ${result.finding?.criticalTurn}`);
        console.log(`Mistake class: ${result.finding?.mistakeClass}`);
        console.log(result.finding?.summary);
      } else {
        console.log('\nKey decisions:');
        const keyDecisions = battle.decisions.slice(-5);
        for (const decision of keyDecisions) {
          console.log(`Turn ${decision.turn}: ${JSON.stringify(decision.action)}`);
          console.log(`  Evaluation: ${decision.evaluation.score.toFixed(2)}`);
        }
      }
    }
  } finally {
    graph?.close();
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
