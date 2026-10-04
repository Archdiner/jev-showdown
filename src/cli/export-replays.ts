#!/usr/bin/env node

import { SelfPlayHarness } from '../learning/self-play.js';
import { BattleLogger } from '../learning/battle-logger.js';
import { dataLoader } from '../data/data-loader.js';
import { replayExporter } from '../utils/replay-exporter.js';
import * as path from 'path';

interface ReplayRequest {
  bot1Type: 'mcts' | 'maxdamage';
  bot2Type: 'mcts' | 'maxdamage' | 'random';
  targetOutcome: 'win' | 'loss' | 'any';
  outputName: string;
}

async function main() {
  console.log('=== Replay Export Utility ===\n');
  console.log('Loading data...');
  
  const { gen9RandomBattle } = await import('../formats/gen9-randombattle.js');
  await dataLoader.load(gen9RandomBattle);
  
  const logger = new BattleLogger();
  const harness = new SelfPlayHarness(logger);
  
  const outputDir = path.join(process.cwd(), 'artifacts', 'replays');
  
  const requests: ReplayRequest[] = [
    {
      bot1Type: 'mcts',
      bot2Type: 'maxdamage',
      targetOutcome: 'win',
      outputName: 'mcts-win-vs-maxdamage.html',
    },
    {
      bot1Type: 'mcts',
      bot2Type: 'maxdamage',
      targetOutcome: 'loss',
      outputName: 'mcts-loss-vs-maxdamage.html',
    },
    {
      bot1Type: 'mcts',
      bot2Type: 'random',
      targetOutcome: 'any',
      outputName: 'mcts-vs-random.html',
    },
  ];
  
  console.log(`\nCollecting replays (max 20 games per request)...\n`);
  
  for (const request of requests) {
    console.log(`Looking for: ${request.bot1Type} ${request.targetOutcome} vs ${request.bot2Type}`);
    
    let found = false;
    let gamesPlayed = 0;
    const maxAttempts = 20;
    
    while (!found && gamesPlayed < maxAttempts) {
      gamesPlayed++;
      
      // Capture battle log during game
      const capturedLogs: string[] = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      let battleLog = '';
      
      // Run one game
      const result = await harness.runGames({
        numGames: 1,
        bot1Type: request.bot1Type,
        bot2Type: request.bot2Type,
        verbose: false,
      });
      
      // Check if this game matches our criteria
      const matchesOutcome = 
        request.targetOutcome === 'any' ||
        (request.targetOutcome === 'win' && result.bot1Wins === 1) ||
        (request.targetOutcome === 'loss' && result.bot2Wins === 1);
      
      if (matchesOutcome && result.lastLog) {
        found = true;
        
        const outcome = result.bot1Wins === 1
          ? `${request.bot1Type} wins` 
          : result.bot2Wins === 1
          ? `${request.bot2Type} wins`
          : 'Tie';
        
        const log = result.lastLog;
        const logSize = Buffer.byteLength(log, 'utf-8');
        
        const outputPath = path.join(outputDir, request.outputName);
        
        await replayExporter.exportReplay(
          log,
          {
            p1: request.bot1Type.toUpperCase(),
            p2: request.bot2Type.toUpperCase(),
            format: 'gen9randombattle',
            outcome,
            timestamp: Date.now(),
          },
          outputPath
        );
        
        console.log(`  ✓ Saved to: ${outputPath} (${(logSize / 1024).toFixed(1)} KB, ${log.split('|turn|').length - 1} turns)`);
      }
    }
    
    if (!found) {
      console.log(`  ✗ Could not find matching game after ${maxAttempts} attempts`);
    }
    
    console.log();
  }
  
  logger.close();
  
  console.log('=== Export Complete ===');
  console.log(`\nReplays saved to: ${outputDir}/`);
  console.log('Open these HTML files in a browser to view battles.');
}

function createFallbackLog(request: ReplayRequest, outcome: string): string {
  return `|j|☆${request.bot1Type}
|j|☆${request.bot2Type}
|gametype|singles
|gen|9
|tier|[Gen 9] Random Battle
|rated|
|rule|Sleep Clause Mod: Limit one foe put to sleep
|rule|HP Percentage Mod: HP is shown in percentages
|
|start
|turn|1
|
|win|${outcome.includes(request.bot1Type) ? request.bot1Type : request.bot2Type}`;
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
