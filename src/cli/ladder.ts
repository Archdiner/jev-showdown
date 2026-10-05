#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { dataLoader } from '../data/data-loader.js';
import { gen9RandomBattle } from '../formats/gen9-randombattle.js';
import { BotConfig } from '../types/index.js';
import { ShowdownClient } from '../client/showdown-client.js';
import { BattleDriver, GameSummary } from '../client/battle-driver.js';
import { DecisionClient } from '../client/decision-client.js';
import { startLocalServer } from '../client/local-server.js';
import { safeError, toID } from '../client/ids.js';
import { clampConcurrency, EngineName, MAX_LADDER_CONCURRENCY, parseEngine } from '../client/engines.js';
import { LadderQueue } from '../client/ladder-queue.js';

interface LadderOptions {
  games: number;
  format: string;
  local: boolean;
  server: string;
  port: number;
  accept: boolean;
  challenge: string;
  username: string;
  searchMs: number | null;
  decisionMs: number | null;
  logDir: string;
  engine: EngineName;
  opponentEngine: EngineName | null;
  concurrency: number;
  help: boolean;
}

function parseArgs(argv: string[]): LadderOptions {
  const opts: LadderOptions = {
    games: 1,
    format: 'gen9randombattle',
    local: false,
    server: '',
    port: 8143,
    accept: false,
    challenge: '',
    username: '',
    searchMs: null,
    decisionMs: null,
    logDir: 'logs/ladder',
    engine: 'max-damage',
    opponentEngine: null,
    concurrency: 1,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--local') opts.local = true;
    else if (arg === '--accept') opts.accept = true;
    else if (arg === '--games') opts.games = Number(next());
    else if (arg === '--format') opts.format = next();
    else if (arg === '--server') opts.server = next();
    else if (arg === '--port') opts.port = Number(next());
    else if (arg === '--challenge') opts.challenge = next();
    else if (arg === '--username') opts.username = next();
    else if (arg === '--search-ms') opts.searchMs = Number(next());
    else if (arg === '--decision-ms') opts.decisionMs = Number(next());
    else if (arg === '--log-dir') opts.logDir = next();
    else if (arg === '--engine') opts.engine = parseEngine(next());
    else if (arg === '--opponent-engine') opts.opponentEngine = parseEngine(next());
    else if (arg === '--concurrency') opts.concurrency = clampConcurrency(Number(next()));
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(opts.games) || opts.games < 1) {
    throw new Error('--games must be a positive number');
  }
  return opts;
}

function printHelp(): void {
  console.log(`Usage:
  npm run ladder -- --games N --format gen9randombattle --engine max-damage
  npm run ladder -- --local --games N --concurrency K --engine max-damage

Real ladder (this process never stores the password):
  SHOWDOWN_USERNAME=bot SHOWDOWN_PASSWORD=secret npm run ladder -- --games 10 --format gen9randombattle --engine max-damage --concurrency 1

Engines: max-damage (default; won a local head-to-head) or search (Bot.selectAction).
--concurrency K keeps up to K battles on one login (default 1, max ${MAX_LADDER_CONCURRENCY}).

Local server, two clients, N games:
  npm run ladder -- --local --games 10 --format gen9randombattle --concurrency 4

One local client against an already-running server:
  npm run ladder -- --local --server ws://127.0.0.1:8143/showdown/websocket --username BotAlpha --accept --games 10
  npm run ladder -- --local --server ws://127.0.0.1:8143/showdown/websocket --username BotBravo --challenge BotAlpha --games 10
`);
}

function engineConfig(opts: LadderOptions): BotConfig {
  const local = opts.local;
  return {
    searchTimeMs: opts.searchMs ?? (local ? 400 : 8000),
    searchIterations: 200,
    explorationConstant: 1.4,
    sampledWorlds: local ? 1 : 4,
    useTeraHeuristic: true,
    useLLMPrior: false,
  };
}

async function makePlayer(input: {
  username: string;
  password: string;
  server: string;
  local: boolean;
  formatId: string;
  opts: LadderOptions;
  label: string;
  engine: EngineName;
  autoSearch?: boolean;
}): Promise<{ client: ShowdownClient; driver: BattleDriver; decisions: DecisionClient; queue: LadderQueue }> {
  fs.mkdirSync(input.opts.logDir, { recursive: true });
  const config = engineConfig(input.opts);
  const decisions = new DecisionClient({
    config,
    engine: input.engine,
    timeoutMs: input.opts.decisionMs ?? (input.local ? 1500 : 12000),
    workers: input.opts.concurrency,
  });
  const client = new ShowdownClient({
    server: input.server,
    username: input.username,
    password: input.password,
    local: input.local,
    format: input.formatId,
    loginServer: process.env.SHOWDOWN_LOGIN_URL,
  });
  const driver = new BattleDriver({
    client,
    username: input.username,
    format: gen9RandomBattle,
    engineName: input.engine,
    decisions,
    logDir: input.opts.logDir,
    decisionTimeoutMs: input.opts.decisionMs ?? (input.local ? 1500 : 12000),
    replayDir: path.join(input.opts.logDir, 'replays'),
  });
  const queue = new LadderQueue(client, input.formatId, input.opts.concurrency, message => {
    console.warn(`[${input.label}] ${message}`);
  }, input.autoSearch !== false);
  client.on('popup', (message: string) => queue.notePopup(message));
  client.on('lobby', (line: string) => queue.noteLobby(line));
  driver.on('battleStart', (roomId: string) => queue.noteBattle(roomId));
  await decisions.start();
  await client.connect();
  console.log(`[${input.label}] logged in as ${input.username} engine=${input.engine} concurrency=${input.opts.concurrency}`);
  return { client, driver, decisions, queue };
}

function watchChallenges(client: ShowdownClient, queue: LadderQueue, onlyFrom: string): void {
  client.on('lobby', (line: string) => {
    if (!line.startsWith('|updatechallenges|')) return;
    if (queue.activeBattles >= queue.limit) return;
    try {
      const payload = JSON.parse(line.slice('|updatechallenges|'.length));
      const from = payload.challengesFrom || {};
      for (const user of Object.keys(from)) {
        if (queue.activeBattles >= queue.limit) return;
        if (onlyFrom && toID(user) !== toID(onlyFrom)) continue;
        client.accept(user);
      }
    } catch (err) {
      console.error(`[ladder] challenge parse failed: ${safeError(err)}`);
    }
  });
}

async function playSeries(
  players: Array<{ client: ShowdownClient; driver: BattleDriver; queue: LadderQueue; name: string }>,
  games: number,
  concurrency: number,
  onContinue?: () => void,
): Promise<GameSummary[]> {
  const finished = new Map<string, GameSummary>();
  return new Promise((resolve, reject) => {
    const waves = Math.ceil(games / Math.max(1, concurrency));
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${finished.size}/${games} games`));
    }, Math.max(300000, waves * 180000));

    const consider = (summary: GameSummary) => {
      if (finished.has(summary.battleId)) return;
      finished.set(summary.battleId, summary);
      console.log(
        `[ladder] ${finished.size}/${games} ${summary.outcome} vs ${summary.opponent ?? '?'} ` +
        `turns=${summary.turns} invalid=${summary.invalidChoices} crashes=${summary.crashes} ` +
        `fallbacks=${summary.fallbacks} elo=${summary.eloAfter ?? 'n/a'}`,
      );
      if (finished.size >= games) {
        for (const player of players) player.queue.stop();
        finishIfDrained();
        return;
      }
      for (const player of players) player.queue.fill();
      onContinue?.();
    };

    const finishIfDrained = () => {
      if (finished.size < games) return;
      if (players.some(player => player.queue.activeBattles > 0)) return;
      clearTimeout(timer);
      for (const player of players) player.queue.stop();
      resolve([...finished.values()]);
    };

    for (const player of players) {
      player.driver.on('gameEnd', (summary: GameSummary) => {
        player.queue.noteEnd(summary.battleId);
        if (finished.has(summary.battleId)) {
          if (finished.size < games) player.queue.fill();
          else finishIfDrained();
          return;
        }
        consider(summary);
      });
    }
    for (const player of players) player.queue.fill();
    onContinue?.();
  });
}

async function runLocalSeries(opts: LadderOptions): Promise<GameSummary[]> {
  console.log(`[ladder] starting local pokemon-showdown on port ${opts.port}`);
  const server = await startLocalServer(opts.port);
  const shutdown = async () => {
    await server.stop();
  };
  process.once('SIGINT', () => {
    console.log('\n[ladder] disconnecting without forfeit');
    void shutdown().finally(() => process.exit(0));
  });

  try {
    const alpha = await makePlayer({
      username: 'BotAlpha',
      password: '',
      server: server.wsUrl,
      local: true,
      formatId: opts.format,
      opts,
      label: 'alpha',
      engine: opts.engine,
    });
    const bravo = await makePlayer({
      username: 'BotBravo',
      password: '',
      server: server.wsUrl,
      local: true,
      formatId: opts.format,
      opts,
      label: 'bravo',
      engine: opts.opponentEngine ?? opts.engine,
    });

    const summaries = await playSeries(
      [
        { client: alpha.client, driver: alpha.driver, queue: alpha.queue, name: 'BotAlpha' },
        { client: bravo.client, driver: bravo.driver, queue: bravo.queue, name: 'BotBravo' },
      ],
      opts.games,
      opts.concurrency,
    );

    await alpha.driver.stop();
    await bravo.driver.stop();
    alpha.client.disconnect();
    bravo.client.disconnect();
    return summaries;
  } finally {
    await shutdown();
  }
}

async function runRemote(opts: LadderOptions): Promise<GameSummary[]> {
  const local = opts.local;
  const username = opts.username || (local ? 'BotAlpha' : process.env.SHOWDOWN_USERNAME || '');
  const password = local ? '' : (process.env.SHOWDOWN_PASSWORD || '');
  if (!username || (!local && !password)) {
    throw new Error('Set SHOWDOWN_USERNAME and SHOWDOWN_PASSWORD. They are not read from source files.');
  }

  const server = opts.server || (local
    ? `ws://127.0.0.1:${opts.port}/showdown/websocket`
    : 'wss://sim3.psim.us/showdown/websocket');

  const player = await makePlayer({
    username,
    password,
    server,
    local,
    formatId: opts.format,
    opts,
    label: toID(username) || 'ladder',
    engine: opts.engine,
    autoSearch: !opts.accept && !opts.challenge,
  });

  if (opts.accept) watchChallenges(player.client, player.queue, opts.challenge);
  process.once('SIGINT', () => {
    console.log('\n[ladder] disconnecting without forfeit');
    void player.driver.stop().finally(() => {
      player.client.disconnect();
      process.exit(0);
    });
  });

  const summaries = await playSeries(
    [{ client: player.client, driver: player.driver, queue: player.queue, name: username }],
    opts.games,
    opts.concurrency,
    opts.challenge
      ? () => player.client.challenge(opts.challenge, opts.format)
      : undefined,
  );

  await player.driver.stop();
  player.client.disconnect();
  return summaries;
}

function report(summaries: GameSummary[], opts: LadderOptions): void {
  const invalidChoices = summaries.reduce((sum, game) => sum + game.invalidChoices, 0);
  const crashes = summaries.reduce((sum, game) => sum + game.crashes, 0);
  const fallbacks = summaries.reduce((sum, game) => sum + game.fallbacks, 0);
  const mismatches = summaries.reduce((sum, game) => sum + game.mismatches, 0);
  const wins = summaries.filter(game => game.outcome === 'win').length;
  const reportBody = {
    games: summaries.length,
    requested: opts.games,
    format: opts.format,
    engine: opts.engine,
    opponentEngine: opts.opponentEngine,
    concurrency: opts.concurrency,
    local: opts.local,
    invalidChoices,
    crashes,
    fallbacks,
    mismatches,
    wins,
    results: summaries,
  };
  fs.mkdirSync(opts.logDir, { recursive: true });
  const out = path.join(opts.logDir, 'summary.json');
  fs.writeFileSync(out, JSON.stringify(reportBody, null, 2));
  console.log(`[ladder] games=${summaries.length} invalid=${invalidChoices} crashes=${crashes} fallbacks=${fallbacks} mismatches=${mismatches}`);
  console.log(`[ladder] summary ${out}`);
  if (invalidChoices > 0 || crashes > 0 || summaries.length < opts.games) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.format !== 'gen9randombattle') {
    throw new Error(`This client is wired for gen9randombattle (got ${opts.format})`);
  }

  console.log('[ladder] loading randbats data');
  await dataLoader.load(gen9RandomBattle);

  const summaries = opts.local && !opts.server && !opts.accept && !opts.challenge
    ? await runLocalSeries(opts)
    : await runRemote(opts);
  report(summaries, opts);
}

main().catch(err => {
  console.error(`[ladder] ${safeError(err)}`);
  process.exit(1);
});
