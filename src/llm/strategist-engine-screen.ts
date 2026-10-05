/**
 * Full strategist (Grok plan, Jev scores, sim veto) vs exact 1-ply.
 * Uses buildBot('configs/strategist.yaml'). Needs VERCEL_AI_GATEWAY_KEY for model calls.
 *
 *   npx tsx src/llm/strategist-engine-screen.ts 20
 *
 * 20 games is 10 seeds, both sides. Showdown's gen 9 random battle clock starts
 * at 150s. The ladder decision budget for this engine is 25s.
 */
import { runGame } from '../bench/game.js';
import { loadConfig, toSpec } from '../config/load.js';
import { teamsForSeed } from '../engine/exact/battle-utils.js';
import { specFromId } from '../engine/exact/policies.js';
import { readTurnMeter, resetTurnMeter } from './turn-meter.js';

const SHOWDOWN_START_S = 150;
const DECISION_BUDGET_MS = 25_000;
const games = Math.max(2, Number(process.argv[2] ?? 20));
const pairs = Math.ceil(games / 2);
const challenger = toSpec(loadConfig('configs/strategist.yaml'), 'ladder');
const champion = specFromId('champion-exact-1ply');
const key = Boolean(process.env.VERCEL_AI_GATEWAY_KEY || process.env.AI_GATEWAY_API_KEY);

resetTurnMeter();
let wins = 0;
let losses = 0;
let ties = 0;
let invalid = 0;
let crashes = 0;
const times: number[] = [];

console.log(`strategist engine screen games=${pairs * 2} apiKey=${key}`);

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
    });
    if (played.crashed) crashes++;
    if (played.winner === 'tie') ties++;
    else if (played.winner === side) wins++;
    else losses++;
    invalid += side === 'p1' ? played.p1Invalid : played.p2Invalid;
    times.push(...(side === 'p1' ? played.p1TurnTimes : played.p2TurnTimes));
    console.log(`seed ${seed} ${side} ${played.winner} turns=${played.turns}`);
  }
}

times.sort((a, b) => a - b);
const at = (p: number) => times[Math.min(times.length - 1, Math.max(0, Math.ceil(p * times.length) - 1))] ?? 0;
const played = wins + losses + ties;
const rate = played ? (wins + ties * 0.5) / played : 0;
const z = 1.96;
const denom = 1 + (z * z) / Math.max(1, played);
const center = (rate + (z * z) / (2 * Math.max(1, played))) / denom;
const margin = (z * Math.sqrt((rate * (1 - rate)) / Math.max(1, played) + (z * z) / (4 * played * played))) / denom;
const meter = readTurnMeter();
const p50 = at(0.5);
const p99 = at(0.99);

console.log(JSON.stringify({
  games: played,
  wins,
  losses,
  ties,
  winRate: rate,
  wilson95: [Math.max(0, center - margin), Math.min(1, center + margin)],
  invalid,
  crashes,
  turns: meter.turns,
  grokCalls: meter.grokCalls,
  jevCalls: meter.jevCalls,
  vetoes: meter.vetoes,
  fallbacks: meter.fallbacks,
  p50Ms: p50,
  p99Ms: p99,
  showdownStartSeconds: SHOWDOWN_START_S,
  decisionBudgetMs: DECISION_BUDGET_MS,
  p99UnderDecisionBudget: p99 <= DECISION_BUDGET_MS,
  costUsd: meter.costUsd,
  costPerGame: played ? meter.costUsd / played : 0,
  apiKey: key,
}, null, 2));
