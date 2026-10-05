/**
 * Screen the simulator veto against exact 1-ply.
 * No gateway key is used. The proposal is max damage; the sim can veto it.
 *
 *   npx tsx src/llm/sim-veto-screen.ts 20
 */
import { runGame } from '../bench/game.js';
import { teamsForSeed } from '../engine/exact/battle-utils.js';
import { specFromId } from '../engine/exact/policies.js';

const games = Math.max(2, Number(process.argv[2] ?? 20));
const pairs = Math.ceil(games / 2);
const challenger = specFromId('sim');
const champion = specFromId('champion-exact-1ply');

let wins = 0;
let losses = 0;
let ties = 0;
let invalid = 0;
let crashes = 0;
let vetoes = 0;
let decisions = 0;
const times: number[] = [];

console.log(`sim veto screen games=${pairs * 2}`);

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
      decisions++;
      if (decision.source === 'veto') vetoes++;
    }
    console.log(`seed ${seed} ${side} ${played.winner} turns=${played.turns}`);
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
  decisions,
  vetoes,
  vetoRate: decisions ? vetoes / decisions : 0,
  p50Ms: at(0.5),
  p99Ms: at(0.99),
}));
