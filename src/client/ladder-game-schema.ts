import { z } from 'zod';

/**
 * Contract for one line of `games.jsonl` (`jev.ladder-game.v1`).
 *
 * Null is a value, not a missing key. Every field below is required unless it
 * is marked optional (ops-only extras).
 *
 * Null is allowed when:
 * - `opponent`, `opponentRating`: the server omitted the other `|player|` line or its rating.
 * - `winner`: `outcome` is `tie`. A win or a loss names the winner.
 * - `eloBefore`: the rating line had no previous number. A number here requires `eloAfter`.
 * - `eloAfter`: the server sent no rating. A number for `gxe` or `eloBefore` requires it.
 * - `gxe`: the rating line had no GXE. Never invent 50.
 * - `latencyP50Ms`, `latencyP95Ms`, `latencyP99Ms`, `latencyMaxMs`: `decisions` is 0.
 *   When `decisions` is greater than 0 they are numbers.
 * - `minTimerMarginSec`: `decisions` is 0, or `replayStatus` is `local-only`
 *   (the local server does not run the ladder timer). A public game that chose
 *   a move has the timer on, so null is a dropped clock.
 * - `configId`, `configHash`, `gitSha`: the batch did not resolve them.
 * - `replayId`: no room id was available. A normal ladder row sets it.
 * - `replayUrl`: `replayStatus` is `unconfirmed` or `local-only`. `confirmed` requires
 *   `https://replay.pokemonshowdown.com/…` and `replayUploaded: true`.
 * - `localReplayPath`: the raw log was not written.
 *
 * `turns` is 0 only for `disconnect`, `crash`, or `unknown` with `decisions` 0.
 * A KO, forfeit, or timer loss with 0 turns is a phantom record.
 */
export const LADDER_GAME_SCHEMA_ID = 'jev.ladder-game.v1' as const;

const endReasonSchema = z.enum([
  'ko',
  'opponent-forfeit',
  'our-forfeit',
  'our-timer',
  'opponent-timer',
  'disconnect',
  'crash',
  'tie',
  'unknown',
]);

const nullableNumber = z.number().finite().nullable();
const PLAYED_END = new Set(['ko', 'opponent-forfeit', 'our-forfeit', 'our-timer', 'opponent-timer', 'tie']);
const LATENCY_KEYS = ['latencyP50Ms', 'latencyP95Ms', 'latencyP99Ms', 'latencyMaxMs'] as const;

export const ladderGameRecordSchema = z.object({
  schema: z.literal(LADDER_GAME_SCHEMA_ID),
  kind: z.literal('ladder-game'),
  source: z.enum(['ladder', 'ops']),
  id: z.string().min(1),
  pid: z.number().int().positive(),
  ts: z.number().finite(),
  startedAt: z.number().finite(),
  battleId: z.string().min(1),
  format: z.string().min(1),
  username: z.string().min(1),
  opponent: z.string().min(1).nullable(),
  opponentRating: nullableNumber,
  outcome: z.enum(['win', 'loss', 'tie']),
  endReason: endReasonSchema,
  winner: z.string().min(1).nullable(),
  turns: z.number().int().nonnegative(),
  invalidChoices: z.number().int().nonnegative(),
  crashes: z.number().int().nonnegative(),
  fallbacks: z.number().int().nonnegative(),
  mismatches: z.number().int().nonnegative(),
  eloBefore: nullableNumber,
  eloAfter: nullableNumber,
  gxe: nullableNumber,
  durationMs: z.number().finite().nonnegative(),
  decisions: z.number().int().nonnegative(),
  latencyP50Ms: nullableNumber,
  latencyP95Ms: nullableNumber,
  latencyP99Ms: nullableNumber,
  latencyMaxMs: nullableNumber,
  minTimerMarginSec: nullableNumber,
  engine: z.string().min(1),
  configId: z.string().min(1).nullable(),
  configHash: z.string().min(1).nullable(),
  gitSha: z.string().min(1).nullable(),
  concurrency: z.number().int().positive(),
  replayId: z.string().min(1).nullable(),
  replayUrl: z.string().min(1).nullable(),
  localReplayPath: z.string().min(1).nullable(),
  replayUploaded: z.boolean(),
  replayStatus: z.enum(['confirmed', 'unconfirmed', 'local-only']),
  logPath: z.string().min(1),
  ourSide: z.enum(['p1', 'p2']).optional(),
  configPath: z.string().min(1).optional(),
  variantId: z.string().min(1).optional(),
  inputLog: z.string().optional(),
  log: z.string().optional(),
}).superRefine((row, ctx) => {
  const fail = (path: string, message: string) => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  };

  if (row.ts >= row.startedAt) {
    if (row.durationMs !== row.ts - row.startedAt) {
      fail('durationMs', 'durationMs must equal ts - startedAt');
    }
  } else if (row.durationMs !== 0) {
    fail('durationMs', 'durationMs must be 0 when ts is before startedAt');
  }

  if (row.outcome === 'tie') {
    if (row.winner !== null) fail('winner', 'winner must be null when outcome is tie');
  } else if (row.winner === null) {
    fail('winner', 'winner is required when outcome is win or loss');
  }

  if (row.endReason === 'our-timer' && row.outcome !== 'loss') {
    fail('endReason', 'our-timer is a loss');
  }
  if (row.endReason === 'opponent-timer' && row.outcome !== 'win') {
    fail('endReason', 'opponent-timer is a win');
  }
  if (row.endReason === 'tie' && row.outcome !== 'tie') {
    fail('endReason', 'endReason tie requires outcome tie');
  }

  if (row.turns === 0 && (PLAYED_END.has(row.endReason) || row.decisions > 0)) {
    fail('turns', 'a 0-turn record is a phantom unless the battle ended before any decision (disconnect, crash, or unknown)');
  }

  for (const key of LATENCY_KEYS) {
    const value = row[key];
    if (row.decisions === 0 && value !== null) fail(key, 'latency is null when decisions is 0');
    if (row.decisions > 0 && value === null) fail(key, 'latency is required when decisions is greater than 0');
  }

  const publicGame = row.replayStatus !== 'local-only';
  if (publicGame && row.decisions > 0 && row.minTimerMarginSec === null) {
    fail('minTimerMarginSec', 'a public game that chose a move must record the timer margin');
  }

  if (row.eloBefore !== null && row.eloAfter === null) {
    fail('eloAfter', 'eloAfter is required when eloBefore is set');
  }
  if (row.gxe !== null && row.eloAfter === null) {
    fail('eloAfter', 'eloAfter is required when gxe is set');
  }

  if (row.replayStatus === 'confirmed') {
    if (!row.replayUrl || !/^https:\/\/replay\.pokemonshowdown\.com\/[a-z0-9-]+/i.test(row.replayUrl)) {
      fail('replayUrl', 'confirmed games require a https://replay.pokemonshowdown.com/ URL');
    }
    if (!row.replayUploaded) fail('replayUploaded', 'confirmed games set replayUploaded');
  } else {
    if (row.replayUrl !== null) fail('replayUrl', 'replayUrl is null unless replayStatus is confirmed');
    if (row.replayUploaded) fail('replayUploaded', 'replayUploaded is false unless a replay URL was confirmed');
  }
});

export type LadderGameContract = z.infer<typeof ladderGameRecordSchema>;

export function formatSchemaError(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

export function validateLadderGameRecord(value: unknown): LadderGameContract {
  const parsed = ladderGameRecordSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`invalid jev.ladder-game.v1 record: ${formatSchemaError(parsed.error)}`);
  }
  return parsed.data;
}

export function validateGamesJsonl(text: string): LadderGameContract[] {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error('games.jsonl is empty');
  const errors: string[] = [];
  const records: LadderGameContract[] = [];
  lines.forEach((line, index) => {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      errors.push(`line ${index + 1}: not JSON`);
      return;
    }
    const parsed = ladderGameRecordSchema.safeParse(json);
    if (!parsed.success) errors.push(`line ${index + 1}: ${formatSchemaError(parsed.error)}`);
    else records.push(parsed.data);
  });
  if (errors.length > 0) {
    throw new Error(`invalid games.jsonl:\n${errors.join('\n')}`);
  }
  return records;
}
