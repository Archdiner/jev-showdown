/** Parsers for ladder JSONL, `[ladder]` lines, and ops live/heartbeat JSONL. */

export type EndReason =
  | 'ko'
  | 'opponent-forfeit'
  | 'our-forfeit'
  | 'timer-ours'
  | 'timer-theirs'
  | 'disconnect'
  | 'crash';

export type LossClass = 'strategy' | 'timer-disconnect' | 'crash' | 'unclassified' | 'not-a-loss';

export interface LatencySummary {
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface GameRecord {
  ts: number;
  battleId: string | null;
  outcome: 'win' | 'loss' | 'tie';
  opponent: string | null;
  opponentRating: number | null;
  ratingBefore: number | null;
  ratingAfter: number | null;
  /** Latest rating, same as ratingAfter. Kept so older callers still see Elo. */
  elo: number | null;
  gxe: number | null;
  replayUrl: string | null;
  endReason: EndReason | null;
  lossClass: LossClass;
  durationMs: number | null;
  turns: number | null;
  latency: LatencySummary | null;
  minTimerSeconds: number | null;
  configId: string | null;
  configPath: string | null;
  configHash: string | null;
  engine: string | null;
  gitSha: string | null;
  concurrency: number | null;
  runner: string | null;
  invalid: number | null;
  crashes: number | null;
  fallbacks: number | null;
  source: string;
  progress: string | null;
}

export interface Heartbeat {
  facility: string;
  pid: number | null;
  ts: number;
  status: string;
  detail: string;
}

export interface ParsedFile {
  games: GameRecord[];
  heartbeats: Heartbeat[];
  openBattles: string[];
  skipped: number;
}

const LADDER_LINE = /^\[([^\]]+)\]\s+(\d+)\/(\d+)\s+(win|loss|tie)\s+vs\s+(.+?)\s+turns=(\d+)\s+invalid=(\d+)\s+crashes=(\d+)\s+fallbacks=(\d+)\s+elo=(\S+)/i;

export function runnerFromName(fileName: string): string {
  const stem = fileName.replace(/\.(jsonl|log|txt)$/i, '');
  if (stem === 'search1' || stem === 'jevsearch') return 'jevsearch';
  if (stem === 'jevlive' || stem === 'live') return 'jevlive';
  if (stem === 'jevnext') return 'jevnext';
  return stem || 'log';
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && value !== 'n/a' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function replayUrl(replayUrlValue: unknown, replayId: unknown): string | null {
  const direct = str(replayUrlValue);
  if (direct && /^https?:\/\//i.test(direct)) return direct;
  const id = str(replayId) || direct;
  if (!id) return null;
  if (/^https?:\/\//i.test(id)) return id;
  return `https://replay.pokemonshowdown.com/${id}`;
}

/** Map the telemetry README phrases onto one enum. Unknown text stays null. */
export function normalizeEndReason(raw: string | null, outcome: GameRecord['outcome']): EndReason | null {
  if (!raw) return null;
  const text = raw.toLowerCase().replace(/[_/]+/g, ' ').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (text === 'ko' || text === 'knockout') return 'ko';
  if (text.includes('opponent') && text.includes('forfeit')) return 'opponent-forfeit';
  if ((text.includes('our') || text.includes('ours')) && text.includes('forfeit')) return 'our-forfeit';
  if (text === 'forfeit') return outcome === 'win' ? 'opponent-forfeit' : outcome === 'loss' ? 'our-forfeit' : null;
  if (text.includes('timer') && (text.includes('their') || text.includes('opponent'))) return 'timer-theirs';
  if (text.includes('timer') && text.includes('our')) return 'timer-ours';
  if (text === 'timer' || text === 'timer loss') return outcome === 'win' ? 'timer-theirs' : 'timer-ours';
  if (text.includes('disconnect')) return 'disconnect';
  if (text.includes('crash')) return 'crash';
  return null;
}

export function classifyLoss(outcome: GameRecord['outcome'], endReason: EndReason | null): LossClass {
  if (outcome !== 'loss') return 'not-a-loss';
  if (endReason === 'timer-ours' || endReason === 'timer-theirs' || endReason === 'disconnect') return 'timer-disconnect';
  if (endReason === 'crash') return 'crash';
  if (endReason === 'ko' || endReason === 'our-forfeit') return 'strategy';
  return 'unclassified';
}

function latencyOf(row: Record<string, unknown>): LatencySummary | null {
  const box = (row.latency && typeof row.latency === 'object' ? row.latency : row.decisionLatency) as Record<string, unknown> | null;
  const p50 = num(box?.p50) ?? num(row.latencyP50);
  const p95 = num(box?.p95) ?? num(row.latencyP95);
  const max = num(box?.max) ?? num(row.latencyMax);
  if (p50 === null && p95 === null && max === null) return null;
  return { p50, p95, max };
}

function finishGame(fields: Omit<GameRecord, 'elo' | 'lossClass' | 'ratingAfter'> & { ratingAfter?: number | null; elo?: number | null }): GameRecord {
  const ratingAfter = fields.ratingAfter ?? fields.elo ?? null;
  const endReason = fields.endReason;
  return { ...fields, ratingAfter, elo: ratingAfter, endReason, lossClass: classifyLoss(fields.outcome, endReason) };
}

export function parseLadderLine(line: string, hint: { source: string; runner: string | null; engine: string | null; ts: number }): GameRecord | null {
  const match = line.trim().match(LADDER_LINE);
  if (!match) return null;
  const outcome = match[4].toLowerCase() as GameRecord['outcome'];
  return finishGame({
    ts: hint.ts,
    battleId: null,
    outcome,
    opponent: match[5],
    opponentRating: null,
    ratingBefore: null,
    ratingAfter: num(match[10]),
    gxe: null,
    replayUrl: null,
    endReason: null,
    durationMs: null,
    turns: Number(match[6]),
    latency: null,
    minTimerSeconds: null,
    configId: hint.engine,
    configPath: null,
    configHash: null,
    engine: hint.engine,
    gitSha: null,
    concurrency: null,
    runner: hint.runner || match[1],
    invalid: Number(match[7]),
    crashes: Number(match[8]),
    fallbacks: Number(match[9]),
    source: hint.source,
    progress: `${match[2]}/${match[3]}`,
  });
}

function outcomeOf(value: string | null): GameRecord['outcome'] | null {
  if (value === 'win' || value === 'loss' || value === 'tie') return value;
  return null;
}

export function parseJsonRecord(row: Record<string, unknown>, hint: { source: string; runner: string | null; engines: Map<string, string> }): { game?: GameRecord; heartbeat?: Heartbeat; opened?: string; closed?: string } | null {
  const kind = String(row.type || row.kind || '');
  const ts = num(row.ts) ?? num(row.timestamp) ?? 0;
  if (row.facility && kind === '') {
    const facility = str(row.facility);
    if (!facility) return null;
    return { heartbeat: { facility, pid: num(row.pid), ts, status: str(row.status) || 'ok', detail: str(row.detail) || '' } };
  }
  const battleId = str(row.battleId) || (kind === 'live-game' || kind === 'game' ? str(row.id) : null);
  if (kind === 'game_start' && battleId) {
    if (typeof row.engine === 'string') hint.engines.set(battleId, row.engine);
    return { opened: battleId };
  }
  const outcome = outcomeOf(str(row.outcome) || str(row.winner));
  const isGame = kind === 'result' || kind === 'live-game' || kind === 'game';
  if (!isGame || !outcome) return null;
  const engine = str(row.engine) || (battleId ? hint.engines.get(battleId) ?? null : null);
  const durationSec = num(row.durationSec) ?? num(row.durationSeconds);
  return {
    closed: battleId || undefined,
    game: finishGame({
      ts,
      battleId,
      outcome,
      opponent: str(row.opponent) || str(row.opponentName),
      opponentRating: num(row.opponentRating) ?? num(row.opponentElo),
      ratingBefore: num(row.ratingBefore) ?? num(row.eloBefore) ?? num(row.ourRatingBefore),
      ratingAfter: num(row.ratingAfter) ?? num(row.eloAfter) ?? num(row.ourRatingAfter) ?? num(row.rating) ?? num(row.elo),
      gxe: num(row.gxe),
      replayUrl: replayUrl(row.replayUrl, row.replayId) || replayUrl(row.replay, null),
      endReason: normalizeEndReason(str(row.endReason) || str(row.end_reason) || str(row.ended), outcome),
      durationMs: num(row.durationMs) ?? num(row.duration) ?? (durationSec === null ? null : durationSec * 1000),
      turns: num(row.turns),
      latency: latencyOf(row),
      minTimerSeconds: num(row.minTimerSeconds) ?? num(row.minSecondsLeft) ?? num(row.minTimerLeft),
      configId: str(row.configId) || engine,
      configPath: str(row.configPath),
      configHash: str(row.configHash) || str(row.config_hash),
      engine,
      gitSha: str(row.gitSha) || str(row.git) || str(row.commit),
      concurrency: num(row.concurrency),
      runner: str(row.runner) || hint.runner,
      invalid: num(row.invalidChoices) ?? num(row.invalid),
      crashes: num(row.crashes),
      fallbacks: num(row.fallbacks),
      source: hint.source,
      progress: null,
    }),
  };
}

export function parseSummary(value: unknown, source: string): GameRecord[] {
  if (!value || typeof value !== 'object') return [];
  const body = value as { engine?: unknown; results?: unknown };
  if (!Array.isArray(body.results)) return [];
  const games: GameRecord[] = [];
  for (const item of body.results) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const outcome = outcomeOf(str(row.outcome));
    if (!outcome) continue;
    const engine = str(row.engine) || str(body.engine);
    games.push(finishGame({
      ts: num(row.ts) ?? 0,
      battleId: str(row.battleId),
      outcome,
      opponent: str(row.opponent),
      opponentRating: num(row.opponentRating),
      ratingBefore: num(row.ratingBefore) ?? num(row.eloBefore),
      ratingAfter: num(row.ratingAfter) ?? num(row.eloAfter) ?? num(row.elo),
      gxe: num(row.gxe),
      replayUrl: replayUrl(row.replayUrl, row.replayId),
      endReason: normalizeEndReason(str(row.endReason), outcome),
      durationMs: num(row.durationMs),
      turns: num(row.turns),
      latency: latencyOf(row),
      minTimerSeconds: num(row.minTimerSeconds),
      configId: str(row.configId) || engine,
      configPath: str(row.configPath),
      configHash: str(row.configHash),
      engine,
      gitSha: str(row.gitSha),
      concurrency: num(row.concurrency),
      runner: 'ladder',
      invalid: num(row.invalidChoices),
      crashes: num(row.crashes),
      fallbacks: num(row.fallbacks),
      source,
      progress: null,
    }));
  }
  return games;
}

/** Mixed log: JSONL records and `[ladder]` result lines. Malformed JSON is skipped. */
export function parseLog(text: string, hint: { source: string; runner: string | null }): ParsedFile {
  const games: GameRecord[] = [];
  const heartbeats: Heartbeat[] = [];
  const open = new Set<string>();
  const engines = new Map<string, string>();
  let skipped = 0;
  let engine: string | null = null;
  let lineNo = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    lineNo += 1;
    const login = line.match(/\[([^\]]+)\]\s+logged in as\s+\S+\s+engine=(\S+)/i);
    if (login) engine = login[2];
    if (line.startsWith('{')) {
      try {
        const parsed = parseJsonRecord(JSON.parse(line) as Record<string, unknown>, { source: hint.source, runner: hint.runner, engines });
        if (!parsed) continue;
        if (parsed.heartbeat) heartbeats.push(parsed.heartbeat);
        if (parsed.opened) open.add(parsed.opened);
        if (parsed.closed) open.delete(parsed.closed);
        if (parsed.game) games.push(parsed.game);
      } catch {
        skipped += 1;
      }
      continue;
    }
    const game = parseLadderLine(line, { source: hint.source, runner: hint.runner, engine, ts: lineNo });
    if (game) games.push(game);
  }
  return { games, heartbeats, openBattles: [...open], skipped };
}
