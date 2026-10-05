#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { accountLockRefusal, readHeldAccountLock } from '../client/account-lock.js';
import {
  defaultLadderRunDirs,
  pidAlive,
  publicAccountConflict,
  readLadderRuns,
  type LadderRunMeta,
} from '../client/ladder-run.js';
import {
  loadConcurrencyFile,
  loadDefaultConcurrencyFile,
  resolveConcurrencyLimit,
  selectLiveEngine,
} from '../client/concurrency-config.js';
import { assertSpeciesFloor, formatDataLine, readDataManifest } from '../data/manifest.js';
import { dataDir } from '../data/paths.js';
import { flagValue, forwardLiveFlags } from '../soak/argv.js';

export interface WorktreeFacts {
  porcelain: string;
  head: string;
  headOnOriginMain: boolean;
  fetchError: string | null;
}

/**
 * Live preflight refuses a dirty tree and a commit that is not contained in origin/main.
 * That is the check for a branch that was rebased or merged without landing.
 */
export function checkWorktree(facts: WorktreeFacts): string | null {
  if (facts.fetchError) return `could not verify origin/main: ${facts.fetchError}`;
  if (!facts.headOnOriginMain) {
    return `HEAD ${facts.head || '(unknown)'} is not on origin/main`;
  }
  const dirty = facts.porcelain.trim();
  if (dirty) return `working tree is not clean:\n${dirty}`;
  return null;
}

/**
 * The account lock is `state/ladder-<userid>.lock`, taken by ladder.ts before login.
 * A live holder blocks preflight. A public live-runs row for this account does too.
 */
export function accountLockReason(
  username: string,
  runs: LadderRunMeta[],
  alive: (pid: number) => boolean = pidAlive,
  stateDir = path.resolve('state'),
): string | null {
  if (!username.trim()) {
    return 'Set SHOWDOWN_USERNAME or pass --username. Refusing to log in without an account.';
  }
  const held = readHeldAccountLock(username, { stateDir, alive });
  if (held) return accountLockRefusal(held);
  return publicAccountConflict(username, runs, alive)?.message ?? null;
}

export function speciesFloorReason(dir: string): { reason: string | null; line: string | null } {
  try {
    const manifest = readDataManifest(dir);
    assertSpeciesFloor(manifest, false);
    return { reason: null, line: formatDataLine(manifest) };
  } catch (err) {
    return { reason: err instanceof Error ? err.message : String(err), line: null };
  }
}

export function loadWorktree(cwd = process.cwd()): WorktreeFacts {
  const head = git(['rev-parse', '--short', 'HEAD'], cwd);
  const fetched = git(['fetch', 'origin', 'main', '--quiet'], cwd);
  if (!fetched.ok) {
    return {
      porcelain: '',
      head: head.ok ? head.stdout : '',
      headOnOriginMain: false,
      fetchError: fetched.error,
    };
  }
  const ancestor = git(['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], cwd);
  const status = git(['status', '--porcelain', '--untracked-files=no'], cwd);
  return {
    porcelain: status.ok ? status.stdout : '',
    head: head.ok ? head.stdout : '',
    headOnOriginMain: ancestor.ok,
    fetchError: !ancestor.ok && ancestor.status !== 1
      ? ancestor.error
      : (!status.ok ? status.error : null),
  };
}

export function readAccountRuns(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): LadderRunMeta[] {
  return defaultLadderRunDirs(env, cwd).flatMap(dir => readLadderRuns(dir));
}

/**
 * Same resolution as ladder.ts `applyLiveConcurrency`: engine profile, config
 * file, then an explicit `--concurrency`. The canary and the child process
 * both use this number, appended last so it wins over a forwarded flag.
 */
export function canaryConcurrency(argv: string[]): number {
  const selected = selectLiveEngine(flagValue(argv, '--engine', 'max-damage'));
  const useEngineProfile = argv.includes('--use-engine-profile');
  const configPath = argv.includes('--concurrency-config')
    ? flagValue(argv, '--concurrency-config', '')
    : '';
  const file = configPath
    ? loadConcurrencyFile(configPath)
    : (useEngineProfile ? loadDefaultConcurrencyFile() : null);
  const concurrency = argv.includes('--concurrency')
    ? Number(flagValue(argv, '--concurrency', ''))
    : null;
  const runners = argv.includes('--runners')
    ? Number(flagValue(argv, '--runners', ''))
    : null;
  return resolveConcurrencyLimit({
    engine: selected.profile,
    useEngineProfile,
    concurrency,
    runners,
    file,
  }).limit;
}

/**
 * Checks the tree, the species table, and the account lock, then plays a
 * 2-game local canary with the same engine flags the live command is about to use.
 */
export async function runPreflight(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) return;

  const reasons: string[] = [];
  const worktree = checkWorktree(loadWorktree());
  if (worktree) reasons.push(worktree);

  const species = speciesFloorReason(dataDir(env));
  if (species.reason) reasons.push(species.reason);

  const username = flagValue(argv, '--username', env.SHOWDOWN_USERNAME || '');
  const account = accountLockReason(username, readAccountRuns(env));
  if (account) reasons.push(account);

  if (reasons.length > 0) {
    fail(reasons);
  }

  console.log(`[preflight] ${species.line}`);
  console.log(`[preflight] account ${username} is free`);
  console.log('[preflight] canary: 2 games on the local server');

  let concurrency: number;
  try {
    concurrency = canaryConcurrency(argv);
  } catch (err) {
    fail([err instanceof Error ? err.message : String(err)]);
  }
  console.log(`[preflight] canary concurrency=${concurrency}`);
  const { runSoak } = await import('../soak/run.js');
  try {
    await runSoak({
      games: 2,
      concurrency,
      engine: flagValue(argv, '--engine', 'max-damage'),
      extra: forwardLiveFlags(argv),
      username,
      phases: ['clean', 'drain'],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail([`canary failed:\n${message}`]);
  }
  console.log('[preflight] ok');
}

function fail(reasons: string[]): never {
  console.error('live preflight failed:');
  for (const reason of reasons) console.error(`- ${reason}`);
  process.exit(1);
}

function git(args: string[], cwd: string): { ok: true; stdout: string; status: 0 } | { ok: false; error: string; status: number | null } {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim();
    return { ok: true, stdout, status: 0 };
  } catch (err) {
    const error = err as { status?: number; stderr?: Buffer | string; message?: string };
    const stderr = typeof error.stderr === 'string' ? error.stderr : error.stderr?.toString('utf8') ?? '';
    return {
      ok: false,
      status: typeof error.status === 'number' ? error.status : null,
      error: (stderr || error.message || 'git failed').trim(),
    };
  }
}

const entry = process.argv[1];
const invoked = Boolean(entry) && import.meta.url === pathToFileURL(path.resolve(entry)).href;
if (invoked) {
  runPreflight(process.argv.slice(2)).catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
