import * as fs from 'fs';
import * as path from 'path';

export interface LedgerEntry {
  ts: number;
  kind: 'run' | 'sweep' | 'ablate' | 'tournament';
  specId: string;
  configId: string;
  configName?: string;
  opponentConfigId?: string;
  games: number;
  wins: number;
  winRate: number;
  devAgreement?: number;
  tuningScore?: number;
  heldOutAgreement?: number;
  liveGames?: number;
}

const LEDGER = path.join(process.cwd(), 'state', 'exp-ledger.json');

export function readLedger(): LedgerEntry[] {
  if (!fs.existsSync(LEDGER)) return [];
  const parsed = JSON.parse(fs.readFileSync(LEDGER, 'utf8')) as LedgerEntry[];
  return Array.isArray(parsed) ? parsed : [];
}

export function appendLedger(entry: LedgerEntry): void {
  const all = readLedger();
  all.push(entry);
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.writeFileSync(LEDGER, JSON.stringify(all, null, 2));
}

export function leaderboard(): Array<{ configId: string; games: number; wins: number; winRate: number }> {
  const map = new Map<string, { games: number; wins: number }>();
  for (const row of readLedger()) {
    const cur = map.get(row.configId) ?? { games: 0, wins: 0 };
    cur.games += row.games;
    cur.wins += row.wins;
    map.set(row.configId, cur);
  }
  return [...map.entries()]
    .map(([configId, bucket]) => ({
      configId,
      games: bucket.games,
      wins: bucket.wins,
      winRate: bucket.games ? bucket.wins / bucket.games : 0,
    }))
    .sort((a, b) => b.winRate - a.winRate || b.games - a.games);
}
