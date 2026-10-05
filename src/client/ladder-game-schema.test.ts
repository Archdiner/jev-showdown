import {
  validateGamesJsonl,
  validateLadderGameRecord,
} from './ladder-game-schema.js';

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const startedAt = 1_000;
  const ts = 5_000;
  return {
    schema: 'jev.ladder-game.v1',
    kind: 'ladder-game',
    source: 'ladder',
    id: 'battle-1-5000',
    pid: 10,
    ts,
    startedAt,
    battleId: 'battle-gen9randombattle-1',
    format: 'gen9randombattle',
    username: 'Bot',
    opponent: 'Rival',
    opponentRating: 1400,
    outcome: 'win',
    endReason: 'ko',
    winner: 'Bot',
    turns: 21,
    invalidChoices: 0,
    crashes: 0,
    fallbacks: 0,
    mismatches: 0,
    eloBefore: 1073,
    eloAfter: 1089,
    gxe: null,
    durationMs: ts - startedAt,
    decisions: 20,
    latencyP50Ms: 40,
    latencyP95Ms: 180,
    latencyP99Ms: 400,
    latencyMaxMs: 400,
    minTimerMarginSec: 12,
    engine: 'max-damage',
    configId: 'maxdamage-v1',
    configHash: 'ab12',
    gitSha: '87b268f',
    concurrency: 1,
    replayId: 'gen9randombattle-1',
    replayUrl: null,
    localReplayPath: 'logs/replay.log',
    replayUploaded: false,
    replayStatus: 'unconfirmed',
    logPath: 'logs/game.jsonl',
    ...overrides,
  };
}

describe('jev.ladder-game.v1', () => {
  it('accepts an unconfirmed public game with a timer margin and a null replay URL', () => {
    expect(validateLadderGameRecord(validRecord()).replayUrl).toBeNull();
  });

  it('accepts a local game whose timer margin is null', () => {
    const record = validateLadderGameRecord(validRecord({
      replayStatus: 'local-only',
      replayUrl: null,
      replayUploaded: false,
      minTimerMarginSec: null,
      eloBefore: 1000,
      eloAfter: 1016,
      gxe: 55,
    }));
    expect(record.minTimerMarginSec).toBeNull();
  });

  it('rejects a public game that chose a move and omitted the timer margin', () => {
    expect(() => validateLadderGameRecord(validRecord({ minTimerMarginSec: null }))).toThrow(
      /minTimerMarginSec/,
    );
  });

  it('rejects a confirmed game with a null replay URL', () => {
    expect(() => validateLadderGameRecord(validRecord({
      replayStatus: 'confirmed',
      replayUrl: null,
      replayUploaded: true,
    }))).toThrow(/replayUrl/);
  });

  it('rejects eloBefore without eloAfter', () => {
    expect(() => validateLadderGameRecord(validRecord({ eloAfter: null }))).toThrow(/eloAfter/);
  });

  it('rejects an empty games.jsonl', () => {
    expect(() => validateGamesJsonl('\n')).toThrow(/empty/);
  });
});
