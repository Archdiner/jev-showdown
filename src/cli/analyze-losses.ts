#!/usr/bin/env node

import { BattleLogger } from '../learning/battle-logger.js';
import { GraphDB } from '../graph/db.js';
import { buildBot } from '../config/bot.js';
import { analyzeLoss } from '../exp/analyst.js';

function opt(name: string): string | undefined {
  const hit = process.argv.find(arg => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const logger = new BattleLogger();
  const configPath = opt('config') || 'configs/champion.yaml';
  const hasKey = Boolean(process.env.VERCEL_AI_GATEWAY_KEY || process.env.AI_GATEWAY_API_KEY);
  const bot = buildBot(configPath, hasKey ? 'ladder' : 'selfplay');
  const graph = hasKey ? new GraphDB() : undefined;
  console.log(`configId=${bot.configId} env=${bot.env.name}`);
  if (!hasKey) console.log('No LLM API key. Reviews stay off. Set VERCEL_AI_GATEWAY_KEY.');

  const losses = logger.getLosses(10);
  console.log(`Found ${losses.length} recent losses\n`);
  try {
    for (let i = 0; i < losses.length; i++) {
      const battle = losses[i];
      console.log(`\n=== Loss ${i + 1}: ${battle.id} ===`);
      const result = await analyzeLoss(bot, battle.log, { db: graph, battleId: battle.id });
      if (!result.ok) {
        console.log(`Review failed: ${result.error}`);
        continue;
      }
      console.log(`Hypothesis: ${result.hypothesisId}`);
      console.log(`${result.finding?.hypothesis.title}`);
      console.log(result.finding?.summary);
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
