import type { CheckHit, Evidence, Incident, InvariantCheck, ObservedGame, Severity } from './types.js';

/** Per-game findings. One episode per check per run, shared by the daemon and --once. */
export const EPISODE_CHECK_IDS = new Set([
  'phantom-games',
  'choice-sent-not-applied',
  'invalid-choices',
  'duplicate-choose-per-rqid',
  'crash-or-fallback',
  'replay-unconfirmed',
  'timer-margin-null',
  'elo-null-on-forfeit',
  'required-fields-null',
]);

export function isEpisodeCheck(checkId: string): boolean {
  return EPISODE_CHECK_IDS.has(checkId);
}

/** Group keys created by this model. Older incidents used the battle id as the key. */
export function isGroupKey(key: string): boolean {
  return key.startsWith('run:') || key.startsWith('sha:') || key === 'unscoped';
}

export interface EpisodeGroup {
  checkId: string;
  key: string;
  severity: Severity;
  title: string;
  suggestedFix: string;
  gitSha: string | null;
  runId: string | null;
  detail: string;
  evidence: Evidence[];
  battles: string[];
  lastFailureTs: number | null;
}

export interface EpisodeGame {
  battleId: string;
  ts: number | null;
  local: boolean;
  phantom: boolean;
  ladder: boolean;
  file: string;
}

export interface EpisodeClock {
  now: number;
  baselineMs: number | null;
  passGames: number;
  passMs: number;
  games: EpisodeGame[];
  runnerAlive: boolean;
}

export function splitHits(
  hits: Array<{ check: InvariantCheck; hit: CheckHit }>,
  baselineMs: number | null,
): { continuous: Array<{ check: InvariantCheck; hit: CheckHit }>; groups: EpisodeGroup[] } {
  const continuous: Array<{ check: InvariantCheck; hit: CheckHit }> = [];
  const buckets = new Map<string, { check: InvariantCheck; hits: CheckHit[] }>();
  const ordered = [...hits].sort((a, b) => a.check.id.localeCompare(b.check.id) || a.hit.key.localeCompare(b.hit.key));
  for (const item of ordered) {
    if (!isEpisodeCheck(item.check.id)) {
      continuous.push(item);
      continue;
    }
    if (!admitted(item.hit.at ?? null, baselineMs)) continue;
    const key = groupKey(item.hit);
    const bucketKey = `${item.check.id}\0${key}`;
    const bucket = buckets.get(bucketKey) ?? { check: item.check, hits: [] };
    bucket.hits.push(item.hit);
    buckets.set(bucketKey, bucket);
  }
  const groups: EpisodeGroup[] = [];
  for (const bucket of buckets.values()) groups.push(toGroup(bucket.check, bucket.hits));
  groups.sort((a, b) => a.checkId.localeCompare(b.checkId) || a.key.localeCompare(b.key));
  return { continuous, groups };
}

export function episodePasses(incident: Pick<Incident, 'lastFailureTs' | 'battles'>, clock: EpisodeClock): number {
  const last = incident.lastFailureTs;
  if (last === null) return 0;
  const failing = new Set(incident.battles);
  const seen = new Set<string>();
  let count = 0;
  for (const game of clock.games) {
    if (!livePass(game, clock.baselineMs)) continue;
    if (game.ts === null || game.ts <= last) continue;
    if (failing.has(game.battleId)) continue;
    if (seen.has(game.battleId)) continue;
    seen.add(game.battleId);
    count += 1;
  }
  return count;
}

export function episodeLivePlay(incident: Pick<Incident, 'lastFailureTs'>, clock: EpisodeClock): number {
  const last = incident.lastFailureTs;
  if (last === null) return 0;
  let latest = last;
  for (const game of clock.games) {
    if (!livePass(game, clock.baselineMs)) continue;
    if (game.ts !== null && game.ts > latest) latest = game.ts;
  }
  const fromGames = Math.max(0, latest - last);
  const fromRunner = clock.runnerAlive ? Math.max(0, clock.now - last) : 0;
  return Math.max(fromGames, fromRunner);
}

export function clearanceMet(incident: Pick<Incident, 'lastFailureTs' | 'battles'>, clock: EpisodeClock): boolean {
  if (incident.lastFailureTs === null) return false;
  return episodePasses(incident, clock) >= clock.passGames || episodeLivePlay(incident, clock) >= clock.passMs;
}

export function clockGames(games: ObservedGame[]): EpisodeGame[] {
  return games.map(game => ({
    battleId: game.battleId,
    ts: game.ts,
    local: game.local || game.battleId.startsWith('battle-local') || game.file.endsWith('live-games.jsonl'),
    phantom: game.phantom,
    ladder: game.ladder,
    file: game.file,
  }));
}

function admitted(at: number | null, baselineMs: number | null): boolean {
  if (baselineMs === null) return true;
  if (at === null) return false;
  return at >= baselineMs;
}

function groupKey(hit: CheckHit): string {
  if (hit.runId) return `run:${hit.runId}`;
  if (hit.gitSha) return `sha:${hit.gitSha}`;
  return 'unscoped';
}

function toGroup(check: InvariantCheck, hits: CheckHit[]): EpisodeGroup {
  const sorted = [...hits].sort((a, b) => (a.battleId ?? a.key).localeCompare(b.battleId ?? b.key) || (a.at ?? 0) - (b.at ?? 0));
  const battles: string[] = [];
  for (const hit of sorted) {
    const battle = hit.battleId || hit.key;
    if (!battles.includes(battle)) battles.push(battle);
  }
  let lastFailureTs: number | null = null;
  let gitSha: string | null = null;
  let runId: string | null = null;
  for (const hit of sorted) {
    if (hit.at !== null && hit.at !== undefined && (lastFailureTs === null || hit.at >= lastFailureTs)) {
      lastFailureTs = hit.at;
      gitSha = hit.gitSha ?? gitSha;
      runId = hit.runId ?? runId;
    } else {
      gitSha = gitSha ?? hit.gitSha ?? null;
      runId = runId ?? hit.runId ?? null;
    }
  }
  const key = groupKey(sorted[0]);
  const evidence: Evidence[] = [];
  for (const hit of sorted) {
    if (evidence.length >= 32) break;
    const battle = hit.battleId || hit.key;
    evidence.push({
      file: hit.evidence[0]?.file ?? 'games',
      line: hit.evidence[0]?.line,
      detail: `${battle} gitSha=${hit.gitSha ?? ''} runId=${hit.runId ?? ''} ${hit.detail}`,
    });
  }
  const noun = battles.length === 1 ? 'game' : 'games';
  const reasons = sorted.map(hit => hit.detail).join(' | ');
  const detail = `${battles.length} ${noun} in ${key}: ${battles.join(', ')}. ${reasons}`.slice(0, 4000);
  return {
    checkId: check.id,
    key,
    severity: check.severity,
    title: check.title,
    suggestedFix: check.suggestedFix,
    gitSha,
    runId,
    detail,
    evidence,
    battles,
    lastFailureTs,
  };
}

function livePass(game: EpisodeGame, baselineMs: number | null): boolean {
  if (game.local || game.phantom || !game.ladder) return false;
  if (!game.battleId || game.battleId.startsWith('battle-local')) return false;
  if (game.file.endsWith('live-games.jsonl')) return false;
  if (game.ts === null) return false;
  if (baselineMs !== null && game.ts < baselineMs) return false;
  return true;
}
