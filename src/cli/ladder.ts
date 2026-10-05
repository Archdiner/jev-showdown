#!/usr/bin/env node

import { buildBot } from '../config/bot.js';
import { LadderSession } from '../config/adapters.js';
import { ShowdownClient } from '../client/showdown-client.js';

function opt(name: string): string | undefined {
  const hit = process.argv.find(arg => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log(`usage: npm run ladder -- [--local] [--config=configs/champion.yaml]
  --local   ws://localhost:8000/showdown/websocket and the local env profile
  --config  strategy file. The same file is used on the local server and the ladder.
Env profiles change time, network, and LLM permission. They do not change configId.
Choices come from buildBot. If the room has no reconstructed battle, the turn is not played.`);
    return;
  }

  const local = process.argv.includes('--local');
  const configPath = opt('config') || 'configs/champion.yaml';
  const env = local ? 'local' : 'ladder';
  const username = process.env.SHOWDOWN_USERNAME || (local ? 'localbot' : '');
  const password = process.env.SHOWDOWN_PASSWORD || '';
  if (!username || (!local && !password)) {
    console.error('Set SHOWDOWN_USERNAME and SHOWDOWN_PASSWORD. --local may omit the password.');
    process.exit(1);
  }

  const bot = buildBot(configPath, env);
  const session = new LadderSession(bot);
  console.log(`configId=${bot.configId} env=${env} file=${configPath}`);

  const client = new ShowdownClient({
    username,
    password,
    format: 'gen9randombattle',
    local,
    server: local ? 'ws://localhost:8000/showdown/websocket' : undefined,
  });

  await client.connect();
  console.log(`Logged in as ${username}`);
  client.searchBattle();

  client.on('request', (room: string, request: unknown) => {
    const side = client.sideFor(room) ?? 'p1';
    void session.onRequest(room, request, client.transcript(room), side).then(choice => {
      client.choose(room, choice);
      console.log(`${room} ${side} ${choice} configId=${bot.configId}`);
    }).catch(error => {
      console.error(`${room} no choice: ${error instanceof Error ? error.message : error}`);
    });
  });

  client.on('battleEnd', (room: string, winner: string | null) => {
    console.log(`Battle ended: ${room}, winner: ${winner || 'tie'}`);
    setTimeout(() => client.searchBattle(), 5000);
  });

  client.on('disconnect', () => process.exit(0));
  process.on('SIGINT', () => {
    client.disconnect();
    process.exit(0);
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
