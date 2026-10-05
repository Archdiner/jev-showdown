import type { Battle } from '@pkmn/sim';
import { decisionBattleFromViewerLog } from '../client/hidden-info.js';
import type { Seat } from './ingest.js';

/**
 * Build a decision battle from a spectator protocol log.
 * Ladder per-battle files do not carry a sim `>start` input log. A `|request|`
 * line is enough to replay the public log the way the ladder client does.
 * The returned battle has our seat as p1.
 */
export function battleFromSpectatorLog(log: string, ourSide: Seat): Battle | null {
  const request = lastRequest(log);
  if (!request) return null;
  return decisionBattleFromViewerLog(log, ourSide, request);
}

function lastRequest(log: string): unknown | null {
  const lines = log.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (!line.startsWith('|request|')) continue;
    try {
      const parsed = JSON.parse(line.slice('|request|'.length));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      return null;
    }
  }
  return null;
}
