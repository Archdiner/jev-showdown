/** A battle with no protocol activity newer than this is a ghost from an old session. */
export const STALE_BATTLE_MS = 70 * 60 * 1000;

/** Unix seconds from `|t:|1700000000`, or null when the line is not a timestamp. */
export function battleTimestamp(line: string): number | null {
  if (!line.startsWith('|t:|')) return null;
  const unix = Number(line.slice('|t:|'.length));
  if (!Number.isFinite(unix) || unix <= 0) return null;
  return unix;
}

/**
 * True when the newest `|t:|` in the joined history is older than 70 minutes.
 * No timestamp means a live local battle, which has no `|t:|` lines.
 */
export function isStaleBattle(newestUnix: number | null, nowMs: number, staleMs = STALE_BATTLE_MS): boolean {
  if (newestUnix === null) return false;
  return nowMs - newestUnix * 1000 > staleMs;
}
