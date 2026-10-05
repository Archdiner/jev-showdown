import * as fs from 'fs';
import * as path from 'path';
import { toID } from './ids.js';
import { pidAlive } from './ladder-run.js';

/** Exclusive ladder login for one account. The file is `state/ladder-<userid>.lock`. */
export interface AccountLock {
  username: string;
  pid: number;
  startedAt: string;
  path: string;
  /** Set when this process replaced a lock whose pid was not running. */
  replacedStale: { pid: number; startedAt: string } | null;
  release(): void;
}

export interface AccountLockOptions {
  stateDir?: string;
  pid?: number;
  startedAt?: string;
  alive?: (pid: number) => boolean;
}

export class AccountLockHeldError extends Error {
  readonly username: string;
  readonly holderPid: number;
  readonly startedAt: string;
  readonly lockPath: string;

  constructor(username: string, holderPid: number, startedAt: string, lockPath: string) {
    super(`another ladder runner already holds ${username} (pid ${holderPid}, started ${startedAt})`);
    this.name = 'AccountLockHeldError';
    this.username = username;
    this.holderPid = holderPid;
    this.startedAt = startedAt;
    this.lockPath = lockPath;
  }
}

export function accountLockPath(stateDir: string, username: string): string {
  const id = toID(username);
  if (!id) throw new Error('Cannot take a ladder account lock without a username');
  return path.join(stateDir, `ladder-${id}.lock`);
}

/** Stderr line for a second runner. Names the live pid and when it started. */
export function accountLockRefusal(err: AccountLockHeldError): string {
  return `[ladder] another runner already holds ${err.username} (pid ${err.holderPid}, started ${err.startedAt}). Exiting so this process does not send choices into the same battles. Lock: ${err.lockPath}`;
}

interface StoredLock {
  pid: number;
  startedAt: string;
  username: string;
}

/**
 * Take `state/ladder-<userid>.lock` for this process.
 * A lock whose pid is still running is left in place and throws.
 * A lock whose pid is dead is removed and replaced.
 */
export function acquireAccountLock(username: string, options: AccountLockOptions = {}): AccountLock {
  const id = toID(username);
  if (!id) throw new Error('Cannot take a ladder account lock without a username');
  const stateDir = options.stateDir ?? path.resolve('state');
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, `ladder-${id}.lock`);
  const pid = options.pid ?? process.pid;
  const startedAt = options.startedAt ?? new Date().toISOString();
  const alive = options.alive ?? pidAlive;
  const body = `${JSON.stringify({ pid, startedAt, username })}\n`;
  let replacedStale: { pid: number; startedAt: string } | null = null;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        fs.writeFileSync(fd, body);
      } finally {
        fs.closeSync(fd);
      }
      return heldLock(username, pid, startedAt, file, replacedStale);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch (readErr) {
        if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw readErr;
      }
      const holder = parseLock(raw);
      if (holder && alive(holder.pid)) {
        throw new AccountLockHeldError(holder.username || username, holder.pid, holder.startedAt, file);
      }
      if (holder) replacedStale = { pid: holder.pid, startedAt: holder.startedAt };
      displaceIfUnchanged(file, raw);
    }
  }
  throw new Error(`Could not take the ladder account lock for ${username} at ${file}`);
}

function heldLock(
  username: string,
  pid: number,
  startedAt: string,
  file: string,
  replacedStale: { pid: number; startedAt: string } | null,
): AccountLock {
  let released = false;
  return {
    username,
    pid,
    startedAt,
    path: file,
    replacedStale,
    release() {
      if (released) return;
      released = true;
      let raw = '';
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch {
        return;
      }
      const holder = parseLock(raw);
      if (!holder || holder.pid !== pid || holder.startedAt !== startedAt) return;
      displaceIfUnchanged(file, raw);
    },
  };
}

function parseLock(raw: string): StoredLock | null {
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown; username?: unknown };
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    if (typeof parsed.startedAt !== 'string' || parsed.startedAt.length === 0) return null;
    const username = typeof parsed.username === 'string' ? parsed.username : '';
    return { pid: parsed.pid, startedAt: parsed.startedAt, username };
  } catch {
    return null;
  }
}

/** Move `file` aside and delete it only when its contents are still `observed`. */
function displaceIfUnchanged(file: string, observed: string): boolean {
  const aside = `${file}.${process.pid}.${Date.now()}.claim`;
  try {
    fs.renameSync(file, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  let moved: string;
  try {
    moved = fs.readFileSync(aside, 'utf8');
  } catch {
    return false;
  }
  if (moved !== observed) {
    try {
      fs.linkSync(aside, file);
      fs.unlinkSync(aside);
    } catch {
      console.error(`[ladder] account lock at ${file} changed while a stale lock was being cleared. The displaced copy is ${aside}.`);
    }
    return false;
  }
  fs.unlinkSync(aside);
  return true;
}
