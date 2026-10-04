#!/usr/bin/env node

import { Bot } from '../bot/bot.js';
import { ShowdownClient } from '../client/showdown-client.js';
import { BattleLogger } from '../learning/battle-logger.js';
import { dataLoader } from '../data/data-loader.js';
import { BotConfig } from '../types/index.js';

async function main() {
  const username = process.env.SHOWDOWN_USERNAME;
  const password = process.env.SHOWDOWN_PASSWORD;

  if (!username || !password) {
    console.error('Error: SHOWDOWN_USERNAME and SHOWDOWN_PASSWORD must be set');
    console.error('Set them in a .env file or environment variables');
    process.exit(1);
  }

  console.log('Loading data...');
  await dataLoader.load();

  const config: BotConfig = {
    searchTimeMs: 5000,
    searchIterations: 1000,
    explorationConstant: 1.4,
    sampledWorlds: 10,
    useTeraHeuristic: true,
    useLLMPrior: false,
  };

  const logger = new BattleLogger();
  const bot = new Bot(config, logger);
  await bot.initialize();

  const client = new ShowdownClient({
    username,
    password,
    format: 'gen9randombattle',
  });

  console.log('Connecting to Pokemon Showdown...');
  await client.connect();

  console.log(`Logged in as ${username}`);
  console.log('Searching for battles...');
  
  client.searchBattle();

  client.on('battleStart', (room) => {
    console.log(`Battle started: ${room}`);
    bot.startBattle(room);
  });

  client.on('request', (room, request) => {
    console.log(`Turn ${request.rqid || '?'} in ${room}`);
  });

  client.on('battleEnd', (room, winner) => {
    console.log(`Battle ended: ${room}, winner: ${winner || 'tie'}`);
    
    const outcome = winner === username ? 'win' : winner ? 'loss' : 'tie';
    bot.endBattle(outcome, winner || 'unknown', 0);
    
    setTimeout(() => {
      console.log('Searching for next battle...');
      client.searchBattle();
    }, 5000);
  });

  client.on('disconnect', () => {
    console.log('Disconnected. Exiting...');
    logger.close();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    client.disconnect();
    logger.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
