import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CHECKS } from './checks.js';
import type { LogRow, SentinelContext } from './types.js';

function ctx(rows: LogRow[]): SentinelContext {
  const now = Date.now();
  return {
    now,
    lookbackMs: 24 * 60 * 60 * 1000,
    baselineMs: null,
    admitMs: 0,
    speciesMin: 500,
    speciesCount: 509,
    speciesPath: 'data/gen9-stats.json',
    speciesError: null,
    rows,
    games: [],
    processes: [],
    drains: [],
    runFiles: [],
    layout: {
      cwd: os.tmpdir(),
      liveRepoDir: null,
      opsDir: os.tmpdir(),
      ladderLogDir: os.tmpdir(),
      liveRunsDir: os.tmpdir(),
      dataDir: os.tmpdir(),
    },
    git: { behind: 0, ref: 'main', detail: 'ok' },
    runSummary: null,
    summaryMtimeMs: null,
  } as unknown as SentinelContext;
}

describe('duplicate-choose-per-rqid', () => {
  const check = CHECKS.find(item => item.id === 'duplicate-choose-per-rqid');
  if (!check) throw new Error('missing check');

  test('flags an unconfirmed watchdog resend for the same rqid (INC-041)', () => {
    const file = path.join(os.tmpdir(), `jev-dup-${Date.now()}.jsonl`);
    const battleId = 'battle-gen9randombattle-2693049384';
    const lines = [
      { type: 'choice-delivery', battleId, rqid: 3, choice: 'move 4|3', sent: true, cause: 'sent', ts: Date.now() },
      { type: 'choice-delivery', battleId, rqid: 3, choice: 'move 4|3', sent: true, cause: 'unconfirmed', retry: 1, ts: Date.now() },
    ];
    fs.writeFileSync(file, `${lines.map(row => JSON.stringify(row)).join('\n')}\n`);
    const rows: LogRow[] = lines.map((value, index) => ({ file, line: index + 1, value: value as Record<string, unknown>, error: undefined }));
    const hits = check.detect(ctx(rows));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].detail).toContain('unconfirmed');
    expect(hits[0].battleId).toBe(battleId);
    fs.rmSync(file, { force: true });
  });

  test('allows a second send after a socket-closed failure', () => {
    const battleId = 'battle-gen9randombattle-1';
    const rows: LogRow[] = [
      { file: 'a.jsonl', line: 1, value: { type: 'choice-delivery', battleId, rqid: 2, choice: 'move 1|2', sent: false, cause: 'socket-closed', ts: Date.now() } as Record<string, unknown>, error: undefined },
      { file: 'a.jsonl', line: 2, value: { type: 'choice-delivery', battleId, rqid: 2, choice: 'move 1|2', sent: true, cause: 'sent', retry: 1, ts: Date.now() } as Record<string, unknown>, error: undefined },
    ];
    expect(check.detect(ctx(rows))).toEqual([]);
  });
});
