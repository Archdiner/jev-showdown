import type { BotSpec } from '../config/interfaces.js';
import { playPaired, sideWinRate } from './play.js';

export interface TournamentRow {
  configId: string;
  name: string;
  elo: number;
  games: number;
  wins: number;
}

/** Round robin. Elo starts at 1500 with K=24. This is not a promotion. */
export async function tournament(specs: BotSpec[], games: number, seedStart: number): Promise<TournamentRow[]> {
  const elo = new Map<string, number>(specs.map(spec => [spec.configId, 1500]));
  const wins = new Map<string, number>(specs.map(spec => [spec.configId, 0]));
  const played = new Map<string, number>(specs.map(spec => [spec.configId, 0]));
  for (let i = 0; i < specs.length; i++) {
    for (let j = i + 1; j < specs.length; j++) {
      const a = specs[i];
      const b = specs[j];
      const results = await playPaired(a, b, games, seedStart + i * 1000 + j);
      const rate = sideWinRate(results, a.configId);
      const score = rate.games ? rate.wins / rate.games : 0.5;
      const expected = 1 / (1 + 10 ** ((elo.get(b.configId)! - elo.get(a.configId)!) / 400));
      elo.set(a.configId, elo.get(a.configId)! + 24 * (score - expected));
      elo.set(b.configId, elo.get(b.configId)! + 24 * ((1 - score) - (1 - expected)));
      wins.set(a.configId, wins.get(a.configId)! + rate.wins);
      wins.set(b.configId, wins.get(b.configId)! + (rate.games - rate.wins));
      played.set(a.configId, played.get(a.configId)! + rate.games);
      played.set(b.configId, played.get(b.configId)! + rate.games);
    }
  }
  return specs
    .map(spec => ({
      configId: spec.configId,
      name: spec.config.name,
      elo: elo.get(spec.configId) ?? 1500,
      games: played.get(spec.configId) ?? 0,
      wins: wins.get(spec.configId) ?? 0,
    }))
    .sort((a, b) => b.elo - a.elo);
}
