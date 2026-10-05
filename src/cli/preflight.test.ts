import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { LadderRunMeta } from '../client/ladder-run.js';
import { writeSpeciesFixture } from '../data/fixture.js';
import { MIN_SPECIES } from '../data/paths.js';
import { accountLockReason, canaryConcurrency, checkWorktree, speciesFloorReason } from './preflight.js';

describe('live preflight', () => {
  it('refuses a dirty tree and a commit that is not on origin/main', () => {
    expect(checkWorktree({
      porcelain: '',
      head: 'abc',
      headOnOriginMain: true,
      fetchError: null,
    })).toBeNull();
    expect(checkWorktree({
      porcelain: ' M src/cli/ladder.ts',
      head: 'abc',
      headOnOriginMain: true,
      fetchError: null,
    })).toMatch(/not clean/);
    expect(checkWorktree({
      porcelain: '',
      head: 'abc',
      headOnOriginMain: false,
      fetchError: null,
    })).toMatch(/not on origin\/main/);
    expect(checkWorktree({
      porcelain: '',
      head: 'abc',
      headOnOriginMain: false,
      fetchError: 'network down',
    })).toMatch(/could not verify origin\/main/);
  });

  it('blocks an empty username and any other public ladder process', () => {
    expect(accountLockReason('', [])).toMatch(/SHOWDOWN_USERNAME/);
    const live: LadderRunMeta = { runId: 'a', pid: 42, username: 'Bot', local: false };
    expect(accountLockReason('Bot', [live], () => true)).toMatch(/already on that account/);
    const unnamed: LadderRunMeta = { runId: 'b', pid: 7, local: false };
    expect(accountLockReason('Bot', [unnamed], () => true)).toMatch(/did not record a username/);
    const local: LadderRunMeta = { runId: 'c', pid: 9, username: 'Bot', local: true };
    expect(accountLockReason('Bot', [local], () => true)).toBeNull();
  });

  it('enforces the species floor even when the test-only flag is set', () => {
    const small = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-preflight-small-'));
    const full = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-preflight-full-'));
    writeSpeciesFixture(small, 1);
    writeSpeciesFixture(full, MIN_SPECIES);
    expect(process.env.JEV_ALLOW_SMALL_DATA).toBe('1');
    expect(speciesFloorReason(small).reason).toMatch(/minimum 500/);
    expect(speciesFloorReason(full).reason).toBeNull();
    expect(speciesFloorReason(full).line).toMatch(/^data species=500 hash=/);
  });

  it('resolves canary concurrency the way the ladder client does', () => {
    expect(canaryConcurrency(['--use-engine-profile', '--engine', 'search'])).toBe(3);
    expect(canaryConcurrency(['--use-engine-profile', '--engine', 'max-damage'])).toBe(4);
    expect(canaryConcurrency(['--use-engine-profile', '--engine', 'grok'])).toBe(1);
    expect(canaryConcurrency([
      '--use-engine-profile',
      '--engine', 'search',
      '--concurrency', '1',
      '--concurrency', '2',
    ])).toBe(2);
    expect(canaryConcurrency([])).toBe(1);
  });
});