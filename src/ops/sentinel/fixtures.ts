import * as fs from 'fs';
import * as path from 'path';
import type { Layout, ProcessSnapshot } from './types.js';

export interface TonightFixture {
  root: string;
  now: number;
  layout: Layout;
  processes: ProcessSnapshot[];
  countedGames: number;
  wins: number;
  losses: number;
  phantoms: number;
  localGames: number;
  eloFirst: number;
  eloLast: number;
}

/** Logs that reproduce one night of ladder and ops failures. Timestamps sit inside a 24h lookback of `now`. */
export function writeTonightFixture(root: string, now = Date.now()): TonightFixture {
  const ladder = path.join(root, 'ladder');
  const ops = path.join(root, 'ops');
  const runs = path.join(root, 'live-runs');
  const data = path.join(root, 'data');
  const state = path.join(root, 'state');
  for (const dir of [ladder, ops, runs, data, state]) fs.mkdirSync(dir, { recursive: true });

  const older = now - 40 * 60 * 1000;
  const game = (row: Record<string, unknown>) => JSON.stringify({
    schema: 'jev.ladder-game.v1',
    kind: 'ladder-game',
    source: 'ladder',
    localServer: false,
    username: 'asad',
    format: 'gen9randombattle',
    invalidChoices: 0,
    crashes: 0,
    fallbacks: 0,
    decisions: 6,
    minTimerMarginSec: 8,
    replayUrl: 'https://replay.pokemonshowdown.com/gen9randombattle-ok',
    replayStatus: 'confirmed',
    ...row,
  });

  const losses: string[] = [];
  for (let index = 0; index < 10; index++) {
    losses.push(game({
      battleId: `battle-loss-${index}`,
      ts: now - 20 * 60 * 1000 + index * 1000,
      outcome: 'loss',
      endReason: 'ko',
      turns: 12,
      eloAfter: 1600 - index * 10,
      gitSha: 'aaa111',
      variantId: 'arm-b',
      configId: 'champion',
    }));
  }

  const games = [
    game({
      battleId: 'battle-phantom',
      ts: older,
      outcome: 'tie',
      endReason: 'disconnect',
      turns: 0,
      eloAfter: 999,
      decisions: 0,
      minTimerMarginSec: null,
      replayUrl: null,
      replayStatus: 'unconfirmed',
    }),
    game({
      battleId: 'battle-dup',
      ts: older + 1000,
      outcome: 'loss',
      endReason: 'our-forfeit',
      turns: 6,
      eloBefore: 1400,
      eloAfter: null,
      gitSha: 'good222',
      variantId: 'arm-a',
    }),
    game({
      battleId: 'battle-timer',
      ts: older + 2000,
      outcome: 'loss',
      endReason: 'our-timer',
      turns: 1,
      eloAfter: 1490,
      decisions: 1,
      minTimerMarginSec: null,
      gitSha: 'good222',
    }),
    game({
      battleId: 'battle-replay',
      ts: older + 3000,
      outcome: 'win',
      endReason: 'ko',
      turns: 22,
      eloAfter: 1505,
      replayUrl: null,
      replayStatus: 'unconfirmed',
      gitSha: 'good222',
      variantId: 'arm-a',
    }),
    game({
      battleId: 'battle-replay',
      ts: older + 3500,
      outcome: 'tie',
      endReason: 'disconnect',
      turns: 4,
      eloAfter: null,
      gitSha: 'good222',
    }),
    game({
      battleId: 'battle-bad',
      ts: older + 4000,
      outcome: 'loss',
      endReason: 'ko',
      turns: 15,
      eloAfter: 1495,
      invalidChoices: 2,
      crashes: 1,
      fallbacks: 1,
      gitSha: 'aaa111',
      variantId: 'arm-b',
    }),
    game({
      schema: 'jev.ladder-game.v1',
      battleId: 'battle-missing',
      ts: older + 5000,
      outcome: null,
      endReason: 'ko',
      turns: 8,
      username: 'asad',
      format: null,
      gitSha: 'good222',
      minTimerMarginSec: 5,
    }),
    ...losses,
    '{not json',
  ];
  fs.writeFileSync(path.join(ladder, 'games.jsonl'), `${games.join('\n')}\n`);
  fs.writeFileSync(path.join(ladder, 'asad-battle-gen9randombattle-timer.jsonl'), `${[
    JSON.stringify({
      ts: older + 2000,
      type: 'choice-delivery',
      kind: 'choice-delivery',
      battleId: 'battle-timer',
      turn: 1,
      choice: 'move 1',
      sent: true,
      pid: 50,
    }),
  ].join('\n')}\n`);
  fs.writeFileSync(path.join(ladder, 'asad-battle-gen9randombattle-dup.jsonl'), `${[
    JSON.stringify({ ts: older + 1000, type: 'choice-delivery', battleId: 'battle-dup', choice: 'move 1', sent: true, pid: 50 }),
    JSON.stringify({ ts: older + 1100, type: 'choice-delivery', battleId: 'battle-dup', choice: 'move 2', sent: true, pid: 51 }),
  ].join('\n')}\n`);
  fs.writeFileSync(path.join(ladder, 'asad-battle-gen9randombattle-ghost.jsonl'), `${JSON.stringify({
    ts: now - 5 * 60 * 1000,
    type: 'turn',
    battleId: 'battle-ghost',
    turn: 4,
    choice: 'move 1',
    sent: true,
  })}\n`);
  fs.writeFileSync(path.join(ladder, 'metrics.jsonl'), `${[13000, 14000, 15000].map((ms, index) => JSON.stringify({
    v: 1,
    ts: now - 60_000,
    type: 'decision',
    battleId: 'battle-replay',
    turn: index + 1,
    latencyMs: ms,
  })).join('\n')}\n`);

  fs.writeFileSync(path.join(ops, 'heartbeats.jsonl'), `${[
    { facility: 'factory', pid: 11, ts: now - 5000, status: 'ok', detail: 'working' },
    { facility: 'factory', pid: 12, ts: now - 4000, status: 'ok', detail: 'working' },
    { facility: 'gatekeeper', pid: 13, ts: now - 3000, status: 'ok', detail: 'working' },
    { facility: 'analyst', pid: 14, ts: now - 2000, status: 'ok', detail: 'reviewed 0' },
    { facility: 'live', pid: 15, ts: now - 120_000, status: 'ok', detail: 'localbot win rating 1000', scope: 'local' },
    { facility: 'live', pid: 15, ts: now - 110_000, status: 'ok', detail: 'asad loss rating 1510', scope: 'ladder' },
  ].map(row => JSON.stringify(row)).join('\n')}\n`);
  fs.writeFileSync(path.join(ops, 'live-games.jsonl'), `${JSON.stringify({
    schema: 'jev.ladder-game.v1',
    kind: 'ladder-game',
    source: 'ops',
    localServer: true,
    battleId: 'battle-local',
    ts: now - 10_000,
    outcome: 'win',
    endReason: 'ko',
    turns: 9,
    eloAfter: 1000,
    username: 'localbot',
    format: 'gen9randombattle',
    replayStatus: 'local-only',
    replayUrl: null,
    minTimerMarginSec: 15,
    invalidChoices: 0,
    crashes: 0,
    fallbacks: 0,
  })}\n`);
  fs.writeFileSync(path.join(ops, 'circuits.json'), JSON.stringify({
    champion: { consecutiveLosses: 5, ratings: [1600, 1500], pulled: true, reason: '5 consecutive losses' },
    explorer: { consecutiveLosses: 2, ratings: [1400], pulled: true, reason: '2 consecutive losses' },
  }, null, 2));
  fs.writeFileSync(path.join(data, 'gen9-stats.json'), JSON.stringify({ pikachu: { usage: 1 } }));
  fs.writeFileSync(path.join(runs, '1000.json'), JSON.stringify({
    runId: '1000',
    pid: 4242,
    engine: 'max-damage',
    username: 'asad',
    local: false,
    drainFile: 'live-runs/1000.drain',
    globalDrainFile: 'state/DRAIN',
  }, null, 2));
  const drainAt = (now - 11 * 60 * 1000) / 1000;
  for (const file of [path.join(runs, '1000.drain'), path.join(state, 'DRAIN')]) {
    fs.writeFileSync(file, '');
    fs.utimesSync(file, drainAt, drainAt);
  }

  fs.writeFileSync(path.join(runs, 'search10.log'), [
    '[ladder] pid=4242 run=10',
    '[ladder] 25/30 win vs foe turns=20 invalid=0 crashes=0 fallbacks=0 elo=1400',
    '[ladder] Timed out after 25/30 games',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(ops, 'cycle.jsonl'), `${JSON.stringify({
    ts: now - 20 * 60 * 1000,
    type: 'loss',
    hypotheses: 1,
    queued: 0,
    reason: 'skipped: no self-play variant for hypothesis hyp-loss',
  })}\n`);

  const processes: ProcessSnapshot[] = [
    { pid: 50, cmd: 'node tsx src/cli/ladder.ts --username asad', env: { SHOWDOWN_USERNAME: 'asad' } },
    { pid: 51, cmd: 'node tsx src/cli/ladder.ts --username asad', env: { SHOWDOWN_USERNAME: 'asad' } },
    { pid: 14, cmd: 'node tsx src/ops/cli.ts analyst', env: { OPS_DIR: ops } },
    { pid: 11, cmd: 'node tsx src/ops/cli.ts factory', env: {} },
    { pid: 12, cmd: 'node tsx src/ops/cli.ts factory', env: {} },
    { pid: 13, cmd: 'node tsx src/ops/cli.ts gatekeeper', env: {} },
  ];

  return {
    root,
    now,
    layout: {
      cwd: root,
      opsDir: ops,
      ladderLogDir: ladder,
      liveRunsDir: runs,
      dataDir: data,
      graphDb: path.join(root, 'graph.db'),
    },
    processes,
    countedGames: 14,
    wins: 1,
    losses: 13,
    phantoms: 1,
    localGames: 1,
    eloFirst: 1490,
    eloLast: 1510,
  };
}
