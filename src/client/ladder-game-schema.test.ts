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
    opponentRatingReason: null,
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
    eloAfterReason: null,
    gxe: null,
    durationMs: ts - startedAt,
    decisions: 20,
    latencyP50Ms: 40,
    latencyP95Ms: 180,
    latencyP99Ms: 400,
    latencyMaxMs: 400,
    minTimerMarginSec: 12,
    minTimerMarginReason: null,
    engine: 'max-damage',
    configId: 'maxdamage-v1',
    configHash: 'ab12',
    gitSha: '87b268f',
    concurrency: 1,
    replayId: 'gen9randombattle-1',
    replayUrl: 'https://replay.pokemonshowdown.com/gen9randombattle-1',
    replayUnavailableReason: null,
    localReplayPath: 'logs/replay.log',
    replayUploaded: false,
    replayStatus: 'unconfirmed',
    logPath: 'logs/game.jsonl',
    ...overrides,
  };
}

describe('jev.ladder-game.v1', () => {
  it('accepts an unconfirmed public game with a synthesized replay URL', () => {
    const record = validateLadderGameRecord(validRecord());
    expect(record.replayUrl).toBe('https://replay.pokemonshowdown.com/gen9randombattle-1');
    expect(record.replayUploaded).toBe(false);
  });

  it('accepts a local game with a log path and the opening clock', () => {
    const record = validateLadderGameRecord(validRecord({
      replayStatus: 'local-only',
      replayUrl: 'logs/local/replay.log',
      replayUnavailableReason: 'local-server',
      replayUploaded: false,
      minTimerMarginSec: 150,
      minTimerMarginReason: 'no-timer-update',
      eloBefore: 1000,
      eloAfter: 1016,
      eloAfterReason: null,
      gxe: 55,
    }));
    expect(record.replayUrl).toBe('logs/local/replay.log');
    expect(record.minTimerMarginSec).toBe(150);
  });

  it('rejects a null timer margin', () => {
    expect(() => validateLadderGameRecord(validRecord({ minTimerMarginSec: null }))).toThrow(
      /minTimerMarginSec/,
    );
  });

  it('rejects a no-timer-update that is not the opening clock', () => {
    expect(() => validateLadderGameRecord(validRecord({
      minTimerMarginSec: 12,
      minTimerMarginReason: 'no-timer-update',
    }))).toThrow(/opening clock/);
  });

  it('rejects a confirmed game with a null replay URL', () => {
    expect(() => validateLadderGameRecord(validRecord({
      replayStatus: 'confirmed',
      replayUrl: null,
      replayUploaded: true,
    }))).toThrow(/replayUrl/);
  });

  it('rejects a confirmed game whose URL is not a public replay', () => {
    expect(() => validateLadderGameRecord(validRecord({
      replayStatus: 'confirmed',
      replayUrl: 'logs/replay.log',
      replayUploaded: true,
    }))).toThrow(/replayUrl/);
  });

  it('rejects eloBefore without eloAfter when the reason is missing', () => {
    expect(() => validateLadderGameRecord(validRecord({ eloAfter: null }))).toThrow(/eloAfter/);
  });

  it('accepts a missing eloAfter when eloAfterReason is unreported', () => {
    const record = validateLadderGameRecord(validRecord({
      eloAfter: null,
      eloAfterReason: 'unreported',
      gxe: null,
    }));
    expect(record.eloAfter).toBeNull();
    expect(record.eloBefore).toBe(1073);
  });

  it('accepts an unrecognized room as unavailable', () => {
    const record = validateLadderGameRecord(validRecord({
      replayUrl: 'unavailable',
      replayUnavailableReason: 'unrecognized-room-id',
      replayStatus: 'unconfirmed',
      replayUploaded: false,
    }));
    expect(record.replayUrl).toBe('unavailable');
  });

  it('rejects an empty games.jsonl', () => {
    expect(() => validateGamesJsonl('\n')).toThrow(/empty/);
  });
});
