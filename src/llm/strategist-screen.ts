/**
 * Screen the strategist against exact 1-ply.
 * Without VERCEL_AI_GATEWAY_KEY every turn falls back to search.
 *
 *   npx tsx src/llm/strategist-screen.ts 20
 *
 * 20 games is 10 seeds, both sides. Pass a larger number on a machine with the key.
 */
import { runGame } from '../bench/game.js';
import { teamsForSeed } from '../engine/exact/battle-utils.js';
import { specFromId } from '../engine/exact/policies.js';

const games = Math.max(2, Number(process.argv[2] ?? 20));
const pairs = Math.ceil(games / 2);
const challenger = specFromId('strategist');
const champion = specFromId('champion-exact-1ply');
const key = Boolean(process.env.VERCEL_AI_GATEWAY_KEY || process.env.AI_GATEWAY_API_KEY);

let wins = 0;
let losses = 0;
let ties = 0;
let invalid = 0;
let crashes = 0;
let grok = 0;
let search = 0;
const times: number[] = [];

console.log(`strategist screen games=${pairs * 2} apiKey=${key}`);

for (let seed = 1; seed <= pairs; seed++) {
  const teams = teamsForSeed(seed);
  for (const side of ['p1', 'p2'] as const) {
    const played = await runGame({
      index: seed,
      seed,
      p1Team: teams.p1,
      p2Team: teams.p2,
      p1: side === 'p1' ? challenger : champion,
      p2: side === 'p2' ? challenger : champion,
      logDecisions: true,
    });
    if (played.crashed) crashes++;
    if (played.winner === 'tie') ties++;
    else if (played.winner === side) wins++;
    else losses++;
    invalid += side === 'p1' ? played.p1Invalid : played.p2Invalid;
    times.push(...(side === 'p1' ? played.p1TurnTimes : played.p2TurnTimes));
    for (const decision of played.decisions ?? []) {
      if (decision.side !== side) continue;
      if (decision.source === 'grok') grok++;
      else search++;
    }
    console.log(`seed ${seed} ${side} ${played.winner} turns=${played.turns} invalid=${side === 'p1' ? played.p1Invalid : played.p2Invalid}`);
  }
}

times.sort((a, b) => a - b);
const at = (p: number) => times[Math.min(times.length - 1, Math.max(0, Math.ceil(p * times.length) - 1))] ?? 0;
const played = wins + losses + ties;
console.log(JSON.stringify({
  games: played,
  wins,
  losses,
  ties,
  winRate: played ? (wins + ties * 0.5) / played : 0,
  invalid,
  crashes,
  grokDecisions: grok,
  searchFallbacks: search,
  p50Ms: at(0.5),
  p99Ms: at(0.99),
  apiKey: key,
}));
