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
import { writeLadderRun } from '../client/ladder-run.js';
import {
  AccountLock,
  AccountLockHeldError,
  accountLockRefusal,
  acquireAccountLock,
  bindLockRemoval,
} from '../client/account-lock.js';
import { safeError, toID } from '../client/ids.js';
import { EngineName, MAX_LADDER_CONCURRENCY, parseEngine } from '../client/engines.js';
import {
  loadConcurrencyFile,
  loadDefaultConcurrencyFile,
  resolveConcurrencyLimit,
  selectLiveEngine,
} from '../client/concurrency-config.js';
import { isAlreadySearching, isSearchRejection, LadderQueue } from '../client/ladder-queue.js';
import {
  drainWatchPaths,
  installDrainSignals,
  LiveDrain,
  runDrainFile,
  shouldFinishSeries,
  watchDrainFiles,
} from '../client/drain.js';
import { LiveMetrics } from '../client/live-metrics.js';
import { SearchAdmission, admissionSettings, ConcurrencyGovernor } from '../client/concurrency-governor.js';
import { currentGitSha } from '../client/game-record.js';
import { installPosthogSink } from '../client/posthog-sink.js';
import {
  formatLiveConfig,
  graphPathFromEnv,
  LadderIdentity,
  resolveLadderIdentity,
} from '../client/ladder-identity.js';
import {
  AbSession,
  appendAbIncident,
  formatAbCanary,
  formatAbPlan,
  preflightCanaries,
  resolveAbPlan,
} from '../client/ab-route.js';

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
  profile: string;
  opponentEngine: EngineName | null;
  concurrency: number;
  concurrencyFlag: number | null;
  runners: number | null;
  useEngineProfile: boolean;
  concurrencyConfig: string;
  useLLMPrior: boolean;
  ramp: boolean;
  rampFrom: number | null;
  rampTarget: number | null;
  labeledChampion: boolean;
  rollback: boolean;
  /** Repeatable `--ab <config>:<share>`. Share is a fraction of battles. */
  ab: string[];
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
    profile: 'max-damage',
    opponentEngine: null,
    concurrency: 1,
    concurrencyFlag: null,
    runners: null,
    useEngineProfile: false,
    concurrencyConfig: '',
    useLLMPrior: false,
    ramp: false,
    rampFrom: null,
    rampTarget: null,
    labeledChampion: false,
    rollback: false,
    ab: [],
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
    else if (arg === '--engine') {
      const selected = selectLiveEngine(next());
      opts.engine = selected.engine;
      opts.profile = selected.profile;
      opts.useLLMPrior = selected.useLLMPrior;
    }
    else if (arg === '--opponent-engine') opts.opponentEngine = parseEngine(next());
    else if (arg === '--concurrency') opts.concurrencyFlag = Number(next());
    else if (arg === '--runners') opts.runners = Number(next());
    else if (arg === '--use-engine-profile') opts.useEngineProfile = true;
    else if (arg === '--concurrency-config') opts.concurrencyConfig = next();
    else if (arg === '--ramp') opts.ramp = true;
    else if (arg === '--no-ramp') opts.ramp = false;
    else if (arg === '--ramp-from') opts.rampFrom = Number(next());
    else if (arg === '--ramp-target') opts.rampTarget = Number(next());
    else if (arg === '--labeled-champion') opts.labeledChampion = true;
    else if (arg === '--rollback') opts.rollback = true;
    else if (arg === '--ab') opts.ab.push(next());
    else if (arg === '--check') opts.check = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(opts.games) || opts.games < 1) {
    throw new Error('--games must be a positive number');
  }
  if (opts.runners !== null && (!Number.isFinite(opts.runners) || opts.runners < 1)) {
    throw new Error('--runners must be a positive number');
  }
  if (opts.concurrencyFlag !== null && (!Number.isFinite(opts.concurrencyFlag) || opts.concurrencyFlag < 1)) {
    throw new Error('--concurrency must be a positive number');
  }
  if (opts.rampFrom !== null && (!Number.isFinite(opts.rampFrom) || opts.rampFrom < 1)) {
    throw new Error('--ramp-from must be a positive number');
  }
  if (opts.rampTarget !== null && (!Number.isFinite(opts.rampTarget) || opts.rampTarget < 1)) {
    throw new Error('--ramp-target must be a positive number');
  }
  return opts;
}

function applyLiveConcurrency(opts: LadderOptions): void {
  const file = opts.concurrencyConfig
    ? loadConcurrencyFile(opts.concurrencyConfig)
    : (opts.useEngineProfile ? loadDefaultConcurrencyFile() : null);
  const resolved = resolveConcurrencyLimit({
    engine: opts.profile,
    useEngineProfile: opts.useEngineProfile,
    concurrency: opts.concurrencyFlag,
    runners: opts.runners,
    file,
  });
  opts.concurrency = resolved.limit;
  console.log(`[ladder] concurrency=${resolved.limit} profile=${resolved.profile}`);
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

Engines: max-damage (default; @smogon/calc maxDamageChoice), search (exact 1-ply, the gate champion; exact is an alias), or grok (search + LLM prior, concurrency 1).
--labeled-champion loads the gatekeeper's active champion at batch start and plays that file for every game in the batch. It stays off unless you pass it.
--rollback plays the builtin policy for --engine even when a champion label is valid.
A missing label, a file whose hash no longer matches the label, or two active champions rolls back to that builtin policy and logs the reason.
The config is chosen once, before the first search. A promotion during the batch does not change it. Drain and start again to pick up a new champion.
Each finished game records configId, configHash, role (champion or challenger), share, and the commit. The startup line is: config live source=... id=... hash=... commit=...
--ab <config>:<share> is repeatable. <config> is a yaml/json path, a config id under configs/, or an engine profile (search, exact, max-damage). <share> is that config's fraction of new battles, in (0, 1]. The shares must sum to at most 1. The rest play the champion (--engine, or --labeled-champion). A battle keeps the arm chosen from a hash of its room id. Concurrency, the turn timer, and the choice watchdog stay shared. One process, one login.
A challenger is pulled to champion-only after an invalid move, a timer loss, a crash, or 4 losses in a row. Each pull is one line in incidents.jsonl.
  npm run ladder -- --games 40 --format gen9randombattle --engine search --concurrency 3 --ab configs/panel/maxdamage.yaml:0.2
--concurrency K keeps up to K battles on one login (default 1, absolute max ${MAX_LADDER_CONCURRENCY}).
--use-engine-profile reads configs/live/concurrency.json (search 3, max-damage 4, grok 1).
--concurrency-config FILE overrides those numbers. --runners N multiplies the limit. An explicit --concurrency wins.
--ramp steps from 3 (search) or 4 (max-damage) up to K while p95 latency and the turn timer stay healthy, and steps back when they do not.
Backpressure always pauses new searches when p95 latency degrades, the turn timer drops under the safety margin, or Showdown throttles a search. Games already running are left in place.
A proxy lock, ban, or ‽/! name exits immediately and does not reconnect.
One account, one runner. Before login the process creates state/ladder-<userid>.lock with O_EXCL, storing pid, start time, and host. If that pid is still running, or the lock is from another host, this process prints the holder and exits non-zero. A lock is stale only when its pid is dead on this host. The file is removed on exit and on SIGINT. The first SIGTERM drains and keeps the lock until the process exits, so a restart cannot log in while this one is still sending choices. --check does not take the lock. A local two-bot series locks BotAlpha and BotBravo.

Graceful drain (finish in-progress games, then exit):
  kill -USR1 <pid>    or    kill -TERM <pid>
  touch state/DRAIN
  touch live-runs/<runId>.drain
The runner prints <pid> and <runId> at startup. The first SIGTERM or SIGUSR1 stops new searches and, once nothing is in progress, exits. A second one exits immediately. A room whose newest |t:| is more than 70 minutes old is forfeited on sight and does not count toward drain or concurrency. Live games are not forfeited.
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
    useLLMPrior: opts.useLLMPrior,
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
  identity: LadderIdentity;
  autoSearch?: boolean;
  metrics?: LiveMetrics;
  admission?: SearchAdmission;
  /** One session for every battle on this login. Absent keeps the process config. */
  route?: AbSession;
}): Promise<{ client: ShowdownClient; driver: BattleDriver; decisions: DecisionClient; queue: LadderQueue }> {
  fs.mkdirSync(input.opts.logDir, { recursive: true });
  const config = engineConfig(input.opts);
  const decisions = new DecisionClient({
    config,
    engine: input.engine,
    timeoutMs: input.opts.decisionMs ?? (input.local ? 1500 : 12000),
    workers: input.opts.concurrency,
    championConfigPath: input.identity.championConfigPath,
  });
  const client = new ShowdownClient({
    server: input.server,
    username: input.username,
    password: input.password,
    local: input.local,
    format: input.formatId,
    loginServer: process.env.SHOWDOWN_LOGIN_URL,
  });
  const posthog = installPosthogSink();
  const driver = new BattleDriver({
    client,
    username: input.username,
    format: gen9RandomBattle,
    engineName: input.engine,
    decisions,
    logDir: input.opts.logDir,
    decisionTimeoutMs: input.opts.decisionMs ?? (input.local ? 1500 : 12000),
    replayDir: path.join(input.opts.logDir, 'replays'),
    configId: input.identity.configId,
    configHash: input.identity.configHash,
    gitSha: input.identity.gitSha,
    configPath: input.identity.configPath,
    concurrency: input.opts.concurrency,
    routeBattle: input.route ? battleId => input.route!.assign(battleId) : undefined,
    onBattleFault: input.route ? (battleId, fault) => input.route!.noteFault(battleId, fault) : undefined,
    onGame: input.route ? record => input.route!.noteGame(record) : undefined,
    localServer: input.local,
    settleMs: input.local ? 400 : 8000,
  });
  const queue = new LadderQueue(client, input.formatId, input.opts.concurrency, message => {
    console.warn(`[${input.label}] ${message}`);
  }, input.autoSearch !== false);
  client.on('accountBlock', (block: AccountBlock) => {
    console.error(`[ladder] ${block.message}`);
    process.exit(1);
  });
  client.on('popup', (message: string) => {
    if (isSearchRejection(message) && !isAlreadySearching(message)) {
      input.admission?.noteThrottle(message);
      input.metrics?.noteThrottle(message);
    }
    queue.notePopup(message);
  });
  client.on('lobby', (line: string) => queue.noteLobby(line));
  driver.on('battleStart', (roomId: string) => queue.noteBattle(roomId));
  client.on('staleRoom', (roomId: string) => {
    console.warn(`[${input.label}] stale battle ${roomId} forfeited; it does not count`);
    queue.noteEnd(roomId);
  });
  input.metrics?.attach(driver);
  input.admission?.watch({ queue, driver });
  driver.on('gameEnd', summary => posthog?.captureGame(summary));
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
  metrics: LiveMetrics | null,
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
      if (summary.phantom) return;
      if (finished.has(summary.battleId)) return;
      finished.set(summary.battleId, summary);
      metrics?.noteGame(summary);
      console.log(
        `[ladder] ${finished.size}/${games} ${summary.outcome} vs ${summary.opponent ?? '?'} ` +
        `turns=${summary.turns} invalid=${summary.invalidChoices} crashes=${summary.crashes} ` +
        `fallbacks=${summary.fallbacks} elo=${summary.eloAfter ?? 'n/a'} ` +
        `config=${summary.configId ?? 'n/a'} role=${summary.role ?? 'n/a'}`,
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

async function runLocalSeries(
  opts: LadderOptions,
  drain: LiveDrain,
  metrics: LiveMetrics,
  admission: SearchAdmission,
  identity: LadderIdentity,
  opponentIdentity: LadderIdentity,
  route: AbSession,
): Promise<GameSummary[]> {
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
      identity,
      metrics,
      admission,
      route,
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
      identity: opponentIdentity,
      metrics,
      admission,
    });

    const summaries = await playSeries(
      [
        { client: alpha.client, driver: alpha.driver, queue: alpha.queue, name: 'BotAlpha' },
        { client: bravo.client, driver: bravo.driver, queue: bravo.queue, name: 'BotBravo' },
      ],
      opts.games,
      opts.concurrency,
      drain,
      metrics,
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

function ladderIdentity(opts: LadderOptions): { username: string; local: boolean } {
  return {
    local: opts.local,
    username: opts.username || (opts.local ? 'BotAlpha' : process.env.SHOWDOWN_USERNAME || ''),
  };
}

async function runRemote(
  opts: LadderOptions,
  drain: LiveDrain,
  metrics: LiveMetrics,
  admission: SearchAdmission,
  identity: LadderIdentity,
  route: AbSession,
): Promise<GameSummary[]> {
  const { username, local } = ladderIdentity(opts);
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
    identity,
    autoSearch: !opts.accept && !opts.challenge,
    metrics,
    admission,
    route,
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
    metrics,
    opts.challenge
      ? () => player.client.challenge(opts.challenge, opts.format)
      : undefined,
  );

  await player.driver.stop();
  player.client.disconnect();
  return summaries;
}

function report(
  summaries: GameSummary[],
  opts: LadderOptions,
  identity: LadderIdentity,
  route: AbSession,
  drain?: LiveDrain,
): void {
  const played = summaries.filter(game => !game.phantom);
  const invalidChoices = played.reduce((sum, game) => sum + game.invalidChoices, 0);
  const crashes = played.reduce((sum, game) => sum + game.crashes, 0);
  const fallbacks = played.reduce((sum, game) => sum + game.fallbacks, 0);
  const mismatches = played.reduce((sum, game) => sum + game.mismatches, 0);
  const wins = played.filter(game => game.outcome === 'win').length;
  const reportBody = {
    games: played.length,
    requested: opts.games,
    format: opts.format,
    engine: opts.engine,
    opponentEngine: opts.opponentEngine,
    concurrency: opts.concurrency,
    configId: identity.configId,
    configHash: identity.configHash,
    gitSha: identity.gitSha,
    configSource: identity.source,
    configPath: identity.configPath,
    configReason: identity.reason,
    ab: route.plan.arms.map(arm => ({
      configId: arm.configId,
      role: arm.role,
      share: arm.share,
      engine: arm.engine,
      configPath: arm.configPath,
    })),
    pulled: route.pulledIds(),
    incidents: route.incidents.length,
    local: opts.local,
    drained: drain?.isDraining ?? false,
    drainReason: drain?.drainReason ?? null,
    invalidChoices,
    crashes,
    fallbacks,
    mismatches,
    wins,
    results: played,
  };
  fs.mkdirSync(opts.logDir, { recursive: true });
  const out = path.join(opts.logDir, 'summary.json');
  fs.writeFileSync(out, JSON.stringify(reportBody, null, 2));
  console.log(`[ladder] games=${played.length} invalid=${invalidChoices} crashes=${crashes} fallbacks=${fallbacks} mismatches=${mismatches}`);
  console.log(`[ladder] summary ${out}`);
  if (drain?.isDraining) {
    console.log(`[ladder] drained (${drain.drainReason}) after ${played.length}/${opts.games} games`);
    if (invalidChoices > 0 || crashes > 0) process.exitCode = 1;
    return;
  }
  if (invalidChoices > 0 || crashes > 0 || played.length < opts.games) {
    process.exitCode = 1;
  }
}

async function runCheck(opts: LadderOptions): Promise<void> {
  for (const canary of preflightCanaries(abPlanFor(opts))) {
    console.log(formatAbCanary(canary));
  }
  const { username, local } = ladderIdentity(opts);
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
  const posthog = installPosthogSink();
  let drained = false;
  try {
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

    const releaseLocks = holdAccountLocks(accountsFor(opts));
    applyLiveConcurrency(opts);
    const gitSha = currentGitSha();
    const identity = resolveLadderIdentity({
      engine: opts.engine,
      labeledChampion: opts.labeledChampion,
      rollback: opts.rollback,
      gitSha,
      graphPath: graphPathFromEnv(),
    });
    const route = openAbRoute(opts, identity);
    const opponentIdentity = resolveLadderIdentity({
      engine: opts.opponentEngine ?? opts.engine,
      labeledChampion: false,
      rollback: false,
      gitSha,
      graphPath: graphPathFromEnv(),
    });
    console.log(formatLiveConfig(identity));
    if (opts.local && !opts.server && !opts.accept && !opts.challenge && opponentIdentity.configId !== identity.configId) {
      console.log(`${formatLiveConfig(opponentIdentity)} role=opponent`);
    }
    console.log('[ladder] loading randbats data');
    await dataLoader.load(gen9RandomBattle);

    const session = openDrain(opts.engine, identity, ladderIdentity(opts), route);
    const metrics = openLiveMetrics(opts, identity, route);
    const admission = openAdmission(opts);
    try {
      const summaries = opts.local && !opts.server && !opts.accept && !opts.challenge
        ? await runLocalSeries(opts, session.drain, metrics, admission, identity, opponentIdentity, route)
        : await runRemote(opts, session.drain, metrics, admission, identity, route);
      metrics.finish({ games: summaries.length, requested: opts.games });
      report(summaries, opts, identity, route, session.drain);
      drained = session.drain.isDraining;
    } finally {
      admission.stop();
      session.close();
      await metrics.close();
      releaseLocks();
    }
  } finally {
    await posthog?.shutdown();
  }
  if (drained) {
    const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
    process.exit(code);
  }
}

function accountsFor(opts: LadderOptions): string[] {
  if (opts.local && !opts.server && !opts.accept && !opts.challenge) return ['BotAlpha', 'BotBravo'];
  const { username } = ladderIdentity(opts);
  if (!username) {
    throw new Error('Set SHOWDOWN_USERNAME and SHOWDOWN_PASSWORD. They are not read from source files.');
  }
  return [username];
}

function holdAccountLocks(usernames: string[]): () => void {
  const held: AccountLock[] = [];
  try {
    for (const username of usernames) {
      const lock = acquireAccountLock(username);
      held.push(lock);
      if (lock.replacedStale) {
        console.error(
          `[ladder] stale account lock for ${username} on ${lock.replacedStale.host || 'this host'} (pid ${lock.replacedStale.pid}, started ${lock.replacedStale.startedAt}) belonged to a dead process. Taking it.`,
        );
      }
      console.log(`[ladder] account lock user=${username} pid=${lock.pid} host=${lock.host} started=${lock.startedAt} file=${lock.path}`);
    }
  } catch (err) {
    for (const lock of held) lock.release();
    throw err;
  }
  const release = () => {
    for (const lock of held) lock.release();
  };
  const unbind = bindLockRemoval(release);
  return () => {
    release();
    unbind();
  };
}

function abPlanFor(opts: LadderOptions, identity = resolveLadderIdentity({
  engine: opts.engine,
  labeledChampion: opts.labeledChampion,
  rollback: opts.rollback,
  gitSha: currentGitSha(),
  graphPath: graphPathFromEnv(),
})) {
  return resolveAbPlan({
    champion: {
      configId: identity.configId,
      configHash: identity.configHash,
      configPath: identity.championConfigPath ?? identity.configPath,
      engine: opts.engine,
    },
    hostEngine: opts.engine,
    specs: opts.ab,
  });
}

function openAbRoute(opts: LadderOptions, identity: LadderIdentity): AbSession {
  const plan = abPlanFor(opts, identity);
  console.log(formatAbPlan(plan));
  return new AbSession(plan, incident => {
    appendAbIncident(opts.logDir, incident);
    console.error(
      `[ladder] incident pull config=${incident.configId} reason=${incident.reason} battle=${incident.battleId} ${incident.detail}`,
    );
  });
}

function openDrain(
  engine: string,
  identity: LadderIdentity,
  account: { username: string; local: boolean },
  route: AbSession,
): { drain: LiveDrain; close(): void } {
  const runId = `${Date.now()}`;
  const drain = new LiveDrain();
  writeLadderRun('live-runs', {
    runId,
    pid: process.pid,
    engine,
    configId: identity.configId,
    configHash: identity.configHash,
    gitSha: identity.gitSha,
    configSource: identity.source,
    configPath: identity.configPath,
    ab: route.plan.arms.map(arm => ({
      configId: arm.configId,
      role: arm.role,
      share: arm.share,
    })),
    username: account.username,
    local: account.local,
    drainFile: runDrainFile(runId),
    globalDrainFile: 'state/DRAIN',
  });
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

function openLiveMetrics(opts: LadderOptions, identity: LadderIdentity, route: AbSession): LiveMetrics {
  const runId = `${Date.now()}-${opts.engine}`;
  const filePath = path.join(opts.logDir, 'metrics.jsonl');
  console.log(`[ladder] metrics ${filePath}`);
  return new LiveMetrics(filePath, {
    runId,
    engine: opts.engine,
    concurrency: opts.concurrency,
    configId: identity.configId,
    configHash: identity.configHash,
    gitSha: identity.gitSha,
    ab: route.plan.arms.map(arm => ({
      configId: arm.configId,
      role: arm.role,
      share: arm.share,
    })),
  });
}

function openAdmission(opts: LadderOptions): SearchAdmission {
  const settings = admissionSettings({
    engine: opts.profile,
    concurrency: opts.concurrency,
    ramp: opts.ramp,
    rampFrom: opts.rampFrom,
    rampTarget: opts.rampTarget,
  });
  console.log(`[ladder] admission initial=${settings.initial} target=${settings.target} ramp=${settings.ramp}`);
  return new SearchAdmission(new ConcurrencyGovernor(settings));
}

main().catch(err => {
  if (err instanceof AccountLockHeldError) console.error(accountLockRefusal(err));
  else console.error(`[ladder] ${safeError(err)}`);
  process.exit(1);
});
