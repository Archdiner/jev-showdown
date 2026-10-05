import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AccountLockHeldError,
  accountLockRefusal,
  acquireAccountLock,
} from './account-lock.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jev-account-lock-'));
}

describe('ladder account lock', () => {
  it('writes pid and start time, and a second acquire names the live holder', () => {
    const dir = tempDir();
    const first = acquireAccountLock('Archinder', {
      stateDir: dir,
      pid: 4242,
      startedAt: '2026-10-05T03:07:00.000Z',
      alive: pid => pid === 4242,
    });
    expect(path.basename(first.path)).toBe('ladder-archinder.lock');
    expect(JSON.parse(fs.readFileSync(first.path, 'utf8'))).toEqual({
      pid: 4242,
      startedAt: '2026-10-05T03:07:00.000Z',
      username: 'Archinder',
    });

    expect(() => acquireAccountLock('archinder', {
      stateDir: dir,
      pid: 99,
      startedAt: '2026-10-05T03:07:06.000Z',
      alive: pid => pid === 4242,
    })).toThrow(AccountLockHeldError);

    try {
      acquireAccountLock('archinder', {
        stateDir: dir,
        pid: 99,
        startedAt: '2026-10-05T03:07:06.000Z',
        alive: pid => pid === 4242,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(AccountLockHeldError);
      const held = err as AccountLockHeldError;
      expect(held.holderPid).toBe(4242);
      expect(held.startedAt).toBe('2026-10-05T03:07:00.000Z');
      expect(accountLockRefusal(held)).toBe(
        '[ladder] another runner already holds Archinder (pid 4242, started 2026-10-05T03:07:00.000Z). Exiting so this process does not send choices into the same battles. Lock: '
        + first.path,
      );
    }
    expect(fs.existsSync(first.path)).toBe(true);
    first.release();
    expect(fs.existsSync(first.path)).toBe(false);
  });

  it('replaces a lock whose pid is dead and then blocks a live one', () => {
    const dir = tempDir();
    const file = path.join(dir, 'ladder-archinder.lock');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({
      pid: 111,
      startedAt: '2026-10-05T01:00:00.000Z',
      username: 'Archinder',
    })}\n`);

    const taken = acquireAccountLock('Archinder', {
      stateDir: dir,
      pid: 222,
      startedAt: '2026-10-05T03:07:06.000Z',
      alive: () => false,
    });
    expect(taken.replacedStale).toEqual({ pid: 111, startedAt: '2026-10-05T01:00:00.000Z' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pid).toBe(222);

    expect(() => acquireAccountLock('Archinder', {
      stateDir: dir,
      pid: 333,
      startedAt: '2026-10-05T03:08:00.000Z',
      alive: pid => pid === 222,
    })).toThrow(/pid 222/);
    taken.release();
  });

  it('release leaves a lock that another pid has replaced', () => {
    const dir = tempDir();
    const first = acquireAccountLock('Archinder', {
      stateDir: dir,
      pid: 1,
      startedAt: '2026-10-05T03:07:00.000Z',
      alive: () => false,
    });
    fs.writeFileSync(first.path, `${JSON.stringify({
      pid: 2,
      startedAt: '2026-10-05T03:09:00.000Z',
      username: 'Archinder',
    })}\n`);
    first.release();
    first.release();
    expect(JSON.parse(fs.readFileSync(first.path, 'utf8')).pid).toBe(2);
  });

  it('locks two accounts in one process and refuses an empty username', () => {
    const dir = tempDir();
    const alpha = acquireAccountLock('BotAlpha', { stateDir: dir, pid: 5, startedAt: 't', alive: () => true });
    const bravo = acquireAccountLock('BotBravo', { stateDir: dir, pid: 5, startedAt: 't', alive: () => true });
    expect(fs.existsSync(alpha.path)).toBe(true);
    expect(fs.existsSync(bravo.path)).toBe(true);
    expect(() => acquireAccountLock('   ', { stateDir: dir })).toThrow(/username/);
    alpha.release();
    bravo.release();
  });

  it('treats a corrupt lock as stale', () => {
    const dir = tempDir();
    const file = path.join(dir, 'ladder-archinder.lock');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, 'not-json');
    const taken = acquireAccountLock('Archinder', {
      stateDir: dir,
      pid: 7,
      startedAt: '2026-10-05T03:07:00.000Z',
      alive: () => true,
    });
    expect(taken.replacedStale).toBeNull();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pid).toBe(7);
    taken.release();
  });

  it('refuses a lock held by a live child and takes it after that child exits', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'ladder-archinder.lock');
    const child = spawn(process.execPath, ['-e', `
      const fs = require('fs');
      fs.mkdirSync(${JSON.stringify(dir)}, { recursive: true });
      fs.writeFileSync(${JSON.stringify(file)}, JSON.stringify({
        pid: process.pid,
        startedAt: '2026-10-05T03:07:00.000Z',
        username: 'Archinder',
      }) + '\\n');
      setInterval(() => {}, 1000);
    `], { stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child did not write the lock')), 2000);
      const wait = () => {
        if (fs.existsSync(file)) {
          clearTimeout(timer);
          resolve();
          return;
        }
        setTimeout(wait, 15);
      };
      wait();
    });

    expect(() => acquireAccountLock('Archinder', { stateDir: dir })).toThrow(AccountLockHeldError);
    child.kill('SIGKILL');
    await new Promise<void>(resolve => child.once('exit', () => resolve()));

    const taken = acquireAccountLock('Archinder', {
      stateDir: dir,
      startedAt: '2026-10-05T03:07:06.000Z',
    });
    expect(taken.pid).toBe(process.pid);
    expect(taken.replacedStale?.pid).toBe(child.pid);
    taken.release();
  });
});
