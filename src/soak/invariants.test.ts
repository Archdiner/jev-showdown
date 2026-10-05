import { evaluateSoak, type SoakObservation } from './invariants.js';

function record(overrides: Record<string, unknown> = {}): string {
  const startedAt = 1_000;
  const ts = 2_000;
  return JSON.stringify({
    schema: 'jev.ladder-game.v1',
    kind: 'ladder-game',
    source: 'ladder',
    id: 'battle-local-1-2000',
    pid: 4,
    ts,
    startedAt,
    battleId: 'battle-local-1',
    format: 'gen9randombattle',
    username: 'SoakBot',
    opponent: 'Foe',
    opponentRating: null,
    outcome: 'win',
    endReason: 'ko',
    winner: 'SoakBot',
    turns: 3,
    invalidChoices: 0,
    crashes: 0,
    fallbacks: 0,
    mismatches: 0,
    eloBefore: 1000,
    eloAfter: 1016,
    gxe: 50,
    durationMs: ts - startedAt,
    decisions: 0,
    latencyP50Ms: null,
    latencyP95Ms: null,
    latencyP99Ms: null,
    latencyMaxMs: null,
    minTimerMarginSec: null,
    engine: 'max-damage',
    configId: 'maxdamage-v1',
    configHash: 'ab',
    gitSha: null,
    concurrency: 3,
    replayId: 'local-1',
    replayUrl: null,
    localReplayPath: null,
    replayUploaded: false,
    replayStatus: 'local-only',
    logPath: 'logs/game.jsonl',
    ...overrides,
  });
}

function observation(overrides: Partial<SoakObservation> = {}): SoakObservation {
  return {
    gamesJsonl: `${record()}\n`,
    replays: [{ roomId: 'battle-local-1', lines: ['|win|SoakBot'] }],
    serverLines: [{ roomId: 'battle-local-1', line: '|win|SoakBot' }],
    chooses: [],
    choiceAckMs: 12_000,
    drainMs: null,
    drainBoundMs: null,
    expectWatchdog: false,
    sawWatchdog: false,
    requireRating: true,
    requestedGames: null,
    minimumRecords: 1,
    ...overrides,
  };
}

describe('soak invariants', () => {
  it('accepts a clean local game', () => {
    expect(evaluateSoak(observation())).toEqual([]);
  });

  it('rejects a timer loss, a phantom record, a misrouted line, and a slow choice', () => {
    const failures = evaluateSoak(observation({
      gamesJsonl: `${record({ endReason: 'our-timer', outcome: 'loss', winner: 'Foe', battleId: 'battle-local-9', id: 'x' })}\n`,
      replays: [{ roomId: 'battle-local-1', lines: ['|move|Thunderbolt'] }],
      serverLines: [
        { roomId: 'battle-local-1', line: '|win|SoakBot' },
        { roomId: 'battle-local-2', line: '|move|Thunderbolt' },
      ],
      chooses: [{ roomId: 'battle-local-1', choice: 'move 1', at: 0, forwarded: true, ackedAt: 20_000 }],
    }));
    expect(failures.join('\n')).toMatch(/our timer/);
    expect(failures.join('\n')).toMatch(/phantom/);
    expect(failures.join('\n')).toMatch(/another room/);
    expect(failures.join('\n')).toMatch(/acknowledged in 20000ms/);
  });

  it('requires the watchdog resend and a drain that stops early', () => {
    const watchdog = evaluateSoak(observation({ expectWatchdog: true, sawWatchdog: false }));
    expect(watchdog.join('\n')).toMatch(/watchdog/);

    const drain = evaluateSoak(observation({
      drainMs: 9_000,
      drainBoundMs: 1_000,
      requestedGames: 1,
    }));
    expect(drain.join('\n')).toMatch(/drain took/);
    expect(drain.join('\n')).toMatch(/played all 1 requested/);
  });
});
