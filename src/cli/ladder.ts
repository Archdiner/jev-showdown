#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { dataLoader } from '../data/data-loader.js';
import { gen9RandomBattle } from '../formats/gen9-randombattle.js';
import { BotConfig } from '../types/index.js';
import { AccountBlock, AccountBlockedError, parseFormatRating, ShowdownClient } from '../client/showdown-client.js';
import { BattleDriver, GameSummary } from '../client/battle-driver.js';
import { DecisionClient } from '../client/decision-client.js';
import { startLocalServer } from '../client/local-server.js';
import { safeError, toID } from '../client/ids.js';
import { clampConcurrency, EngineName, MAX_LADDER_CONCURRENCY, parseEngine } from '../client/engines.js';
import { LadderQueue } from '../client/ladder-queue.js';
import {
  drainWatchPaths,
  installDrainSignals,
  LiveDrain,
  runDrainFile,
  runMetaFile,
  shouldFinishSeries,
  watchDrainFiles,
} from '../client/drain.js';

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
  check: boolean;
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
    check: false,
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
    else if (arg === '--check') opts.check = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(opts.games) || opts.games < 1) {
    throw new Error('--games must be a positive number');
  }
  return opts;
}

function printHelp(): void {
  console.log(`Usage:
  npm run ladder -- --check
  npm run ladder -- --games N --format gen9randombattle --engine max-damage
  npm run ladder -- --local --games N --concurrency K --engine max-damage

Preflight (log in, print named/locked and the current rating, exit):
  npm run ladder -- --check

Real ladder, from a residential or university network (this process never stores the password):
  SHOWDOWN_USERNAME=bot SHOWDOWN_PASSWORD=secret npm run ladder -- --games 10 --format gen9randombattle --engine max-damage --concurrency 1

Engines: max-damage (default; won a local head-to-head) or search (Bot.selectAction).
--concurrency K keeps up to K battles on one login (default 1, max ${MAX_LADDER_CONCURRENCY}).
A proxy lock, ban, or ‽/! name exits immediately and does not reconnect.

Graceful drain (finish in-progress games, never /forfeit, then exit):
  kill -USR1 <pid>    or    kill -TERM <pid>
  touch state/DRAIN
  touch live-runs/<runId>.drain
The runner prints <pid> and <runId> at startup. A second SIGTERM or SIGUSR1 exits immediately.
SIGINT still disconnects right away and does not send /forfeit.

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
  client.on('accountBlock', (block: AccountBlock) => {
    console.error(`[ladder] ${block.message}`);
    process.exit(1);
  });
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
  drain: LiveDrain,
  onContinue?: () => void,
): Promise<GameSummary[]> {
  const finished = new Map<string, GameSummary>();
  return new Promise((resolve, reject) => {
    const waves = Math.ceil(games / Math.max(1, concurrency));
    let settled = false;
    let timer = setTimeout(onTimeout, Math.max(300000, waves * 180000));

    function activeGames(): number {
      return players.reduce((sum, player) => sum + player.queue.activeBattles, 0);
    }

    function succeed(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const player of players) player.queue.stop();
      resolve([...finished.values()]);
    }

    function onTimeout(): void {
      if (drain.isDraining) {
        console.warn(`[ladder] stopped waiting with ${activeGames()} game(s) still in progress`);
        succeed();
        return;
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Timed out after ${finished.size}/${games} games`));
    }

    const tryClose = () => {
      if (!shouldFinishSeries({
        finished: finished.size,
        requested: games,
        draining: drain.isDraining,
        active: activeGames(),
      })) return;
      succeed();
    };

    const stopSearching = () => {
      for (const player of players) player.queue.drain();
    };

    drain.onDrain(reason => {
      console.log(`[ladder] draining (${reason}); in-progress games will finish`);
      stopSearching();
      clearTimeout(timer);
      timer = setTimeout(onTimeout, 30 * 60 * 1000);
      tryClose();
    });

    const consider = (summary: GameSummary) => {
      if (finished.has(summary.battleId)) return;
      finished.set(summary.battleId, summary);
      console.log(
        `[ladder] ${finished.size}/${games} ${summary.outcome} vs ${summary.opponent ?? '?'} ` +
        `turns=${summary.turns} invalid=${summary.invalidChoices} crashes=${summary.crashes} ` +
        `fallbacks=${summary.fallbacks} elo=${summary.eloAfter ?? 'n/a'}`,
      );
      if (finished.size >= games || drain.isDraining) {
        stopSearching();
        tryClose();
        return;
      }
      for (const player of players) player.queue.fill();
      onContinue?.();
    };

    for (const player of players) {
      player.driver.on('gameEnd', (summary: GameSummary) => {
        player.queue.noteEnd(summary.battleId);
        if (finished.has(summary.battleId)) {
          if (finished.size < games && !drain.isDraining) player.queue.fill();
          else tryClose();
          return;
        }
        consider(summary);
      });
    }
    if (drain.isDraining) {
      stopSearching();
      tryClose();
      return;
    }
    for (const player of players) player.queue.fill();
    onContinue?.();
  });
}

async function runLocalSeries(opts: LadderOptions, drain: LiveDrain): Promise<GameSummary[]> {
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
      drain,
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

async function runRemote(opts: LadderOptions, drain: LiveDrain): Promise<GameSummary[]> {
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
    drain,
    opts.challenge
      ? () => player.client.challenge(opts.challenge, opts.format)
      : undefined,
  );

  await player.driver.stop();
  player.client.disconnect();
  return summaries;
}

function report(summaries: GameSummary[], opts: LadderOptions, drain?: LiveDrain): void {
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
    drained: drain?.isDraining ?? false,
    drainReason: drain?.drainReason ?? null,
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
  if (drain?.isDraining) {
    console.log(`[ladder] drained (${drain.drainReason}) after ${summaries.length}/${opts.games} games`);
    if (invalidChoices > 0 || crashes > 0) process.exitCode = 1;
    return;
  }
  if (invalidChoices > 0 || crashes > 0 || summaries.length < opts.games) {
    process.exitCode = 1;
  }
}

async function runCheck(opts: LadderOptions): Promise<void> {
  const local = opts.local;
  const username = opts.username || (local ? 'BotAlpha' : process.env.SHOWDOWN_USERNAME || '');
  const password = local ? '' : (process.env.SHOWDOWN_PASSWORD || '');
  if (!username || (!local && !password)) {
    throw new Error('Set SHOWDOWN_USERNAME and SHOWDOWN_PASSWORD. They are not read from source files.');
  }

  let localServer: Awaited<ReturnType<typeof startLocalServer>> | null = null;
  if (local && !opts.server) {
    console.log(`[ladder] starting local pokemon-showdown on port ${opts.port}`);
    localServer = await startLocalServer(opts.port);
  }
  const server = opts.server || (local
    ? `ws://127.0.0.1:${opts.port}/showdown/websocket`
    : 'wss://sim3.psim.us/showdown/websocket');

  const client = new ShowdownClient({
    server,
    username,
    password,
    local,
    format: opts.format,
    loginServer: process.env.SHOWDOWN_LOGIN_URL,
  });

  const reportBlock = (block: AccountBlock) => {
    console.error(`[ladder] user=${username} named=yes locked=yes`);
    console.error(`[ladder] ${block.message}`);
    process.exitCode = 1;
  };

  try {
    let blocked: AccountBlock | null = null;
    client.on('accountBlock', (block: AccountBlock) => {
      blocked = block;
    });
    try {
      await client.connect();
    } catch (err) {
      if (blocked || err instanceof AccountBlockedError) {
        reportBlock(blocked ?? (err as AccountBlockedError).block);
        return;
      }
      throw err;
    }
    if (client.isBlocked()) {
      reportBlock(blocked ?? {
        kind: 'locked',
        message: 'Showdown locked this account. Exiting with no reconnect.',
      });
      return;
    }

    const rating = await readFormatRating(client, opts.format);
    console.log(`[ladder] user=${username} named=yes locked=no`);
    if (rating === 'unknown') console.log(`[ladder] ${opts.format} rating=unknown`);
    else if (rating === 'none') console.log(`[ladder] ${opts.format} rating=none`);
    else console.log(`[ladder] ${opts.format} rating=${rating}`);
  } finally {
    client.disconnect();
    if (localServer) await localServer.stop();
  }
}

function readFormatRating(client: ShowdownClient, format: string): Promise<number | 'none' | 'unknown'> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      client.off('line', onLine);
      resolve('unknown');
    }, 8000);
    const onLine = (_room: string, line: string) => {
      const parsed = parseFormatRating(line, format);
      if (parsed === undefined) return;
      clearTimeout(timer);
      client.off('line', onLine);
      resolve(parsed === null ? 'none' : parsed);
    };
    client.on('line', onLine);
    if (!client.queryRank()) {
      clearTimeout(timer);
      client.off('line', onLine);
      resolve('unknown');
    }
  });
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
  if (opts.check) {
    await runCheck(opts);
    return;
  }

  console.log('[ladder] loading randbats data');
  await dataLoader.load(gen9RandomBattle);

  const session = openDrain(opts.engine);
  try {
    const summaries = opts.local && !opts.server && !opts.accept && !opts.challenge
      ? await runLocalSeries(opts, session.drain)
      : await runRemote(opts, session.drain);
    report(summaries, opts, session.drain);
  } finally {
    session.close();
  }
}

function openDrain(engine: string): { drain: LiveDrain; close(): void } {
  const runId = `${Date.now()}`;
  const drain = new LiveDrain();
  const meta = runMetaFile(runId);
  fs.mkdirSync(path.dirname(meta), { recursive: true });
  fs.writeFileSync(meta, JSON.stringify({
    runId,
    pid: process.pid,
    engine,
    drainFile: runDrainFile(runId),
    globalDrainFile: 'state/DRAIN',
  }, null, 2));
  console.log(`[ladder] pid=${process.pid} run=${runId}`);
  console.log(`[ladder] drain: kill -USR1 ${process.pid}`);
  console.log(`[ladder] drain: kill -TERM ${process.pid}`);
  console.log('[ladder] drain: touch state/DRAIN');
  console.log(`[ladder] drain: touch live-runs/${runId}.drain`);
  const stopSignals = installDrainSignals(signal => drain.request(signal));
  const watcher = watchDrainFiles(drainWatchPaths(runId), file => {
    console.log(`[ladder] drain file ${file}`);
    drain.request(`file:${file}`);
  });
  return {
    drain,
    close() {
      watcher.stop();
      stopSignals();
    },
  };
}

main().catch(err => {
  console.error(`[ladder] ${safeError(err)}`);
  process.exit(1);
});
