import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { toID } from '../client/ids.js';
import { writeSpeciesFixture } from '../data/fixture.js';
import { MIN_SPECIES } from '../data/paths.js';
import { startLocalServer } from '../ops/local-server.js';
import { buildLadderArgv } from './argv.js';
import { evaluateSoak, type SoakObservation } from './invariants.js';
import { startSoakProxy, type SoakFaults } from './proxy.js';

export type SoakPhase = 'clean' | 'fault' | 'drain';

export interface RunSoakOptions {
  /** Finished games the clean phase asks for. The client may run a few more to fill concurrency. */
  games?: number;
  concurrency?: number;
  engine?: string;
  /** Live flags forwarded after the soak's own connection flags, so these win on duplicates. */
  extra?: string[];
  username?: string;
  phases?: SoakPhase[];
  choiceAckMs?: number;
  drainBoundMs?: number;
  waveTimeoutMs?: number;
}

export interface SoakReport {
  elapsedMs: number;
  phases: Array<{ phase: SoakPhase; elapsedMs: number; records: number }>;
}

const DEFAULT_CHOICE_ACK_MS = 12_000;
const DEFAULT_DRAIN_BOUND_MS = 240_000;
const DEFAULT_WAVE_TIMEOUT_MS = 300_000;

export class SoakError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SoakError';
  }
}

/**
 * Starts the ops local Showdown server, proxies it, and runs `src/cli/ladder.ts`
 * (the live client) at the requested concurrency.
 */
export async function runSoak(options: RunSoakOptions = {}): Promise<SoakReport> {
  if (fs.existsSync(path.resolve('state/DRAIN'))) {
    throw new SoakError('state/DRAIN exists. Remove it before a soak or canary so the client will search.');
  }
  const phases = options.phases ?? ['clean', 'fault', 'drain'];
  const concurrency = positive(options.concurrency ?? 3, 'concurrency');
  const games = positive(options.games ?? 1, 'games');
  const started = Date.now();
  const done: SoakReport['phases'] = [];
  for (const phase of phases) {
    const phaseStarted = Date.now();
    const records = await runPhase(phase, {
      ...options,
      games,
      concurrency,
    });
    const elapsedMs = Date.now() - phaseStarted;
    done.push({ phase, elapsedMs, records });
    console.log(`[soak] phase=${phase} elapsed=${elapsedMs}ms records=${records}`);
  }
  const elapsedMs = Date.now() - started;
  console.log(`[soak] ok elapsed=${elapsedMs}ms`);
  return { elapsedMs, phases: done };
}

async function runPhase(phase: SoakPhase, options: RunSoakOptions & { games: number; concurrency: number }): Promise<number> {
  const faults: SoakFaults = {
    dropFirstChoice: phase === 'fault',
    duplicateJoin: phase === 'fault',
  };
  const requested = phase === 'drain' ? Math.max(options.concurrency * 2, 4) : options.games;
  const username = options.username || 'SoakBot';
  const engine = options.engine || 'max-damage';
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), `jev-soak-${phase}-`));
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-soak-data-'));
  writeSpeciesFixture(dataDirectory, MIN_SPECIES);

  const server = await startLocalServer(0);
  const proxy = await startSoakProxy(server.url, faults);
  let child: ChildProcess | null = null;
  let output = '';
  try {
    const args = buildLadderArgv({
      server: proxy.url,
      games: requested,
      logDir,
      username,
      concurrency: options.concurrency,
      engine,
      extra: options.extra ?? [],
    });
    child = spawnLadder(args, dataDirectory);
    child.stdout?.on('data', chunk => {
      const text = chunk.toString();
      output = tail(output, text);
      process.stdout.write(text);
    });
    child.stderr?.on('data', chunk => {
      const text = chunk.toString();
      output = tail(output, text);
      process.stderr.write(text);
    });

    let drainMs: number | null = null;
    const waveTimeoutMs = options.waveTimeoutMs ?? DEFAULT_WAVE_TIMEOUT_MS;
    const drainBoundMs = options.drainBoundMs ?? DEFAULT_DRAIN_BOUND_MS;
    if (phase === 'drain') {
      const sawBattle = await waitForBattle(logDir, child, Math.min(60_000, waveTimeoutMs));
      if (!sawBattle) {
        throw new SoakError(`drain phase never started a battle\n${output}`);
      }
      const marked = Date.now();
      if (!child.pid) throw new SoakError('ladder pid missing');
      console.log(`[soak] drain signal pid=${child.pid}`);
      process.kill(child.pid, 'SIGUSR1');
      const code = await waitForExit(child, drainBoundMs);
      drainMs = Date.now() - marked;
      await finishPhase(phase, {
        code,
        output,
        logDir,
        username,
        proxy,
        requested,
        drainMs,
        drainBoundMs,
        minimumRecords: 1,
        choiceAckMs: options.choiceAckMs ?? DEFAULT_CHOICE_ACK_MS,
      });
    } else {
      const code = await waitForExit(child, waveTimeoutMs);
      await finishPhase(phase, {
        code,
        output,
        logDir,
        username,
        proxy,
        requested,
        drainMs: null,
        drainBoundMs: null,
        minimumRecords: options.games,
        choiceAckMs: options.choiceAckMs ?? DEFAULT_CHOICE_ACK_MS,
      });
    }
    const gamesFile = path.join(logDir, 'games.jsonl');
    const text = fs.existsSync(gamesFile) ? fs.readFileSync(gamesFile, 'utf8') : '';
    return text.split('\n').filter(line => line.trim()).length;
  } finally {
    if (child && child.exitCode === null && !child.killed) {
      child.kill('SIGKILL');
    }
    await proxy.close();
    await server.close();
  }
}

async function finishPhase(phase: SoakPhase, input: {
  code: number | null;
  output: string;
  logDir: string;
  username: string;
  proxy: Awaited<ReturnType<typeof startSoakProxy>>;
  requested: number;
  drainMs: number | null;
  drainBoundMs: number | null;
  minimumRecords: number;
  choiceAckMs: number;
}): Promise<void> {
  const gamesFile = path.join(input.logDir, 'games.jsonl');
  const observation: SoakObservation = {
    gamesJsonl: fs.existsSync(gamesFile) ? fs.readFileSync(gamesFile, 'utf8') : '',
    replays: readReplays(input.logDir, input.username),
    serverLines: input.proxy.serverLines,
    chooses: input.proxy.chooses,
    choiceAckMs: input.choiceAckMs,
    drainMs: input.drainMs,
    drainBoundMs: input.drainBoundMs,
    expectWatchdog: phase === 'fault',
    sawWatchdog: sawWatchdog(input.logDir),
    requireRating: true,
    requestedGames: phase === 'drain' ? input.requested : null,
    minimumRecords: input.minimumRecords,
  };
  const failures = evaluateSoak(observation);
  if (input.code !== 0) failures.push(`ladder exited ${input.code}`);
  if (failures.length === 0) return;
  throw new SoakError(
    `soak ${phase} failed:\n${failures.map(line => `- ${line}`).join('\n')}\n--- ladder output ---\n${input.output}`,
  );
}

function spawnLadder(args: string[], dataDirectory: string): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, JEV_DATA_DIR: dataDirectory };
  delete env.JEV_ALLOW_SMALL_DATA;
  const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('src/cli/ladder.ts'), ...args], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise(resolve => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, timeoutMs);
    child.once('exit', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitForBattle(logDir: string, child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) return false;
    if (hasBattleLog(logDir)) return true;
    await delay(200);
  }
  return false;
}

function hasBattleLog(logDir: string): boolean {
  if (!fs.existsSync(logDir)) return false;
  for (const name of fs.readdirSync(logDir)) {
    if (!name.endsWith('.jsonl') || name === 'games.jsonl' || name === 'metrics.jsonl') continue;
    const text = fs.readFileSync(path.join(logDir, name), 'utf8');
    if (text.includes('"game_start"') || text.includes('"type":"turn"')) return true;
  }
  return false;
}

function sawWatchdog(logDir: string): boolean {
  if (!fs.existsSync(logDir)) return false;
  for (const name of fs.readdirSync(logDir)) {
    if (!name.endsWith('.jsonl') || name === 'games.jsonl' || name === 'metrics.jsonl') continue;
    const text = fs.readFileSync(path.join(logDir, name), 'utf8');
    if (text.includes('"cause":"unconfirmed"')) return true;
  }
  return false;
}

function readReplays(logDir: string, username: string): { roomId: string; lines: string[] }[] {
  const dir = path.join(logDir, 'replays');
  if (!fs.existsSync(dir)) return [];
  const prefix = `${toID(username)}-`;
  const replays: { roomId: string; lines: string[] }[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.log')) continue;
    const stem = name.slice(0, -'.log'.length);
    if (!stem.startsWith(prefix)) continue;
    const lines = fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean);
    replays.push({ roomId: stem.slice(prefix.length), lines });
  }
  return replays;
}

function positive(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new SoakError(`${name} must be a positive integer (got ${value})`);
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function tail(previous: string, next: string): string {
  const combined = previous + next;
  return combined.length > 12_000 ? combined.slice(-12_000) : combined;
}
