import { isPhantomRecord as ladderPhantom, recordedElo, recordedOutcome } from '../../client/game-record.js';
import type { LogRow, ObservedGame } from './types.js';

/**
 * Same rule as the ladder record: `phantom: true`, or a 0-turn tie whose
 * reason is disconnect or unknown. A real `|tie|` (endReason `tie`) stays.
 */
export function isPhantomRecord(game: {
  phantom?: unknown;
  turns: number | null;
  endReason: string | null;
  outcome: 'win' | 'loss' | 'tie' | null;
  winner?: unknown;
}): boolean {
  return ladderPhantom({
    phantom: game.phantom,
    turns: game.turns,
    winner: game.winner,
    outcome: game.outcome,
    endReason: game.endReason,
  });
}

export function observeGames(rows: LogRow[]): ObservedGame[] {
  const games: ObservedGame[] = [];
  for (const row of rows) {
    const value = row.value;
    if (!value || !isGameRow(value)) continue;
    const outcome = recordedOutcome({
      outcome: text(value.outcome),
      winner: text(value.winner),
    });
    const endReason = text(value.endReason) ?? text(value.end_reason);
    const turns = numberOrNull(value.turns);
    const local = isLocal(value);
    const game: ObservedGame = {
      file: row.file,
      line: row.line,
      battleId: text(value.battleId) ?? text(value.id) ?? '',
      ts: numberOrNull(value.ts),
      turns,
      outcome,
      endReason,
      eloBefore: numberOrNull(value.eloBefore) ?? numberOrNull(value.ratingBefore),
      eloAfter: recordedElo({
        eloAfter: numberOrNull(value.eloAfter),
        rating: numberOrNull(value.rating) ?? numberOrNull(value.ratingAfter) ?? numberOrNull(value.elo),
      }),
      invalid: numberOrNull(value.invalidChoices) ?? numberOrNull(value.invalid) ?? 0,
      invalidChoiceReasons: invalidChoiceReasonsOf(value.invalidChoiceReasons),
      crashes: numberOrNull(value.crashes) ?? 0,
      fallbacks: numberOrNull(value.fallbacks) ?? 0,
      minTimerMarginSec: numberOrNull(value.minTimerMarginSec) ?? numberOrNull(value.minTimerSeconds),
      replayUrl: text(value.replayUrl) ?? text(value.replay),
      replayStatus: text(value.replayStatus),
      local,
      ladder: isLadder(value, local),
      gitSha: text(value.gitSha) ?? text(value.git) ?? text(value.commit),
      variantId: text(value.variantId),
      configId: text(value.configId),
      username: text(value.username),
      format: text(value.format),
      schema: text(value.schema),
      decisions: numberOrNull(value.decisions),
      latencyP95Ms: latencyP95(value),
      phantom: false,
      source: text(value.source),
    };
    game.phantom = isPhantomRecord({
      phantom: value.phantom,
      turns,
      endReason,
      outcome,
      winner: value.winner,
    });
    games.push(game);
  }
  return games;
}

function isGameRow(value: Record<string, unknown>): boolean {
  const kind = text(value.kind);
  const type = text(value.type);
  const schema = text(value.schema);
  if (schema === 'jev.ladder-game.v1') return true;
  if (kind === 'ladder-game' || kind === 'live-game') return true;
  if (type === 'result' || type === 'game') {
    return value.outcome != null || value.winner != null || value.endReason != null || value.turns != null;
  }
  return false;
}

function isLocal(value: Record<string, unknown>): boolean {
  if (value.localServer === true || value.local === true) return true;
  if (text(value.scope) === 'local' || text(value.source) === 'local') return true;
  const name = `${text(value.username) ?? ''} ${text(value.detail) ?? ''}`;
  return /\blocalbot\b|\bbotalpha\b|\bbotbravo\b|127\.0\.0\.1/i.test(name);
}

function isLadder(value: Record<string, unknown>, local: boolean): boolean {
  if (local) return false;
  if (value.localServer === false) return true;
  const scope = text(value.scope);
  const source = text(value.source);
  if (scope === 'ladder' || source === 'ladder') return true;
  return false;
}

function latencyP95(value: Record<string, unknown>): number | null {
  const direct = numberOrNull(value.latencyP95Ms) ?? numberOrNull(value.latencyP95);
  if (direct !== null) return direct;
  const latency = value.latency;
  if (latency && typeof latency === 'object' && !Array.isArray(latency)) {
    return numberOrNull((latency as { p95?: unknown }).p95);
  }
  return null;
}

/**
 * Reasons from `invalidChoiceReasons` when another writer has added the field.
 * Accepts a string, a list of strings, or objects with `reason`, `message`, or `text`.
 * An absent or empty field contributes nothing.
 */
export function invalidChoiceReasonsOf(value: unknown): string[] {
  const found: string[] = [];
  const push = (text: string) => {
    const trimmed = text.trim();
    if (trimmed && !found.includes(trimmed)) found.push(trimmed);
  };
  if (typeof value === 'string') {
    push(value);
    return found;
  }
  if (!Array.isArray(value)) return found;
  for (const item of value) {
    if (typeof item === 'string') {
      push(item);
      continue;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const reason = record.reason ?? record.message ?? record.text;
    if (typeof reason === 'string') push(reason);
  }
  return found;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
