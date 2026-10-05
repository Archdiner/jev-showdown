import * as fs from 'fs';
import * as path from 'path';
import { buildBot } from '../config/bot.js';
import type { BotSpec } from '../config/interfaces.js';
import { agreement, heldOutPositions, loadPool } from '../config/positions.js';

export interface LiveResults {
  games?: number;
  wins?: number;
  winRate?: number;
  rating?: number;
  source?: string;
}

export interface GatekeeperReport {
  heldOut: { positions: number; agreement: number | null };
  live: LiveResults | null;
}

const LIVE_FILE = path.join(process.cwd(), 'state', 'live-results.json');

/**
 * The only scoring path for the held-out split. Sweeps do not call this.
 * Live numbers are read from state/live-results.json when that file exists.
 */
export async function checkGatekeeper(spec: BotSpec, poolFile?: string): Promise<GatekeeperReport> {
  const held = heldOutPositions(loadPool(poolFile));
  const bot = buildBot(spec);
  const score = held.length
    ? await agreement(held, (battle, side) => bot.decide({ battle, side }))
    : null;
  return {
    heldOut: { positions: held.length, agreement: score },
    live: readLive(),
  };
}

export function readLive(): LiveResults | null {
  if (!fs.existsSync(LIVE_FILE)) return null;
  const parsed = JSON.parse(fs.readFileSync(LIVE_FILE, 'utf8')) as LiveResults;
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed;
}
