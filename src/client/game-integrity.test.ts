import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ladderGamesForGate } from '../ops/gatekeeper.js';
import { dailyReport } from '../ops/report.js';
import { opsPaths } from '../ops/paths.js';
import { runSentinel } from '../ops/sentinel.js';
import { parseLog } from '../dashboard/parse.js';
import {
  battleRowChoice,
  checkGameInvariants,
  countableGameRows,
  repairGameLog,
} from './game-integrity.js';

const loss = {
  kind: 'ladder-game',
  schema: 'jev.ladder-game.v1',
  battleId: 'battle-gen9randombattle-2692985848',
  id: 'battle-gen9randombattle-2692985848-1',
  pid: 100,
  ts: 1,
  startedAt: 1,
  outcome: 'loss',
  endReason: 'ko',
  winner: 'Jxjdndnd',
  turns: 12,
  opponent: 'Jxjdndnd',
  replayUrl: 'https://replay.pokemonshowdown.com/gen9randombattle-2692985848',
  minTimerMarginSec: 150,
  eloAfter: 1100,
  opponentRating: 1400,
  durationMs: 80_000,
  configId: 'champion',
  gitSha: '085aaa6',
};

const intruder = {
  ...loss,
  id: 'battle-gen9randombattle-2692985848-2',
  pid: 53856,
  ts: 2,
  startedAt: 50_000,
  outcome: 'tie',
  endReason: 'disconnect',
  winner: null,
  turns: 4,
  opponent: 'Jxjdndnd',
};

describe('game log integrity', () => {
  it('keeps the decisive result and drops the non-owning disconnect tie', () => {
    const counted = countableGameRows([intruder, loss]);
    expect(counted).toHaveLength(1);
    expect(counted[0]).toMatchObject({ pid: 100, outcome: 'loss' });
    expect(ladderGamesForGate([intruder, loss])).toEqual(counted);
    expect(battleRowChoice(
      { outcome: 'tie', endReason: 'disconnect', turns: 4 },
      { outcome: 'loss', endReason: 'ko', turns: 12 },
    )).toBe('b');
  });

  it('flags existing contaminated rows without deleting the raw log', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-repair-'));
    const file = path.join(dir, 'games.jsonl');
    const raw = `${JSON.stringify(loss)}\n${JSON.stringify(intruder)}\n`;
    fs.writeFileSync(file, raw);
    expect(repairGameLog(file)).toEqual({ flagged: 1 });
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);
    expect(repairGameLog(file)).toEqual({ flagged: 0 });
    const flags = fs.readFileSync(path.join(dir, 'games.contamination.jsonl'), 'utf8');
    expect(flags).toContain('"reason":"non-owning-process"');
    expect(flags).toContain('53856');
    expect(flags).not.toContain('"pid":100');
  });

  it('sentinel catches a duplicate battle id, a null replay, and a null required field', () => {
    const clean = { ...loss, battleId: 'battle-gen9randombattle-1' };
    const duplicate = { ...loss, battleId: 'battle-gen9randombattle-1', id: 'again', ts: 3 };
    const missingReplay = { ...loss, battleId: 'battle-gen9randombattle-2', replayUrl: null };
    const missingTimer = {
      ...loss,
      battleId: 'battle-gen9randombattle-2692991018',
      minTimerMarginSec: null,
      replayUrl: 'https://replay.pokemonshowdown.com/gen9randombattle-2692991018',
    };
    const findings = checkGameInvariants([clean, duplicate, missingReplay, missingTimer]);
    expect(findings.map(item => item.code)).toEqual(expect.arrayContaining([
      'duplicate-battle-id',
      'null-replay-url',
      'null-required-field',
    ]));
    expect(findings.find(item => item.code === 'null-required-field' && item.field === 'minTimerMarginSec')?.battleId)
      .toBe('battle-gen9randombattle-2692991018');
    expect(checkGameInvariants([clean])).toEqual([]);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-sentinel-'));
    const file = path.join(dir, 'games.jsonl');
    fs.writeFileSync(file, [clean, duplicate, missingReplay, missingTimer].map(row => JSON.stringify(row)).join('\n') + '\n');
    const report = runSentinel([file]);
    expect(report.findings).toBeGreaterThan(0);
    expect(report.text).toContain('duplicate-battle-id');
    expect(report.text).toContain('null-replay-url');
    expect(report.text).toContain('null-required-field');
  });

  it('keeps a duplicate disconnect out of the ops scorecard and the dashboard', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-score-'));
    const paths = opsPaths(root);
    fs.writeFileSync(paths.liveGames, [loss, intruder].map(row => JSON.stringify(row)).join('\n') + '\n');
    const day = dailyReport(paths, 10_000);
    expect(day).toContain('champion won 0% of 1 games');
    expect(day).not.toContain('of 2 games');

    const parsed = parseLog([
      JSON.stringify(loss),
      JSON.stringify(intruder),
    ].join('\n'), { source: 'games.jsonl', runner: 'ladder' });
    expect(parsed.games).toHaveLength(1);
    expect(parsed.games[0].outcome).toBe('loss');
  });
});
