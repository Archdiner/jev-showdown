/**
 * Strategist (critical-turn Grok plan, Jev every turn, sim veto) vs a frozen opponent.
 * Uses buildBot('configs/strategist.yaml'). Needs VERCEL_AI_GATEWAY_KEY for model calls.
 *
 *   npx tsx src/llm/strategist-engine-screen.ts 20
 *   npx tsx src/llm/strategist-engine-screen.ts 20 --opponent max-damage
 *   npx tsx src/llm/strategist-engine-screen.ts 20 --opponent random
 *   npx tsx src/llm/strategist-engine-screen.ts 20 --opponent exact
 *
 * 20 games is 10 seeds, both sides. Showdown's gen 9 random battle clock starts
 * at 150s. The strategist decision cap is configs/strategist.yaml timeBudgetMs.
 */
import { runGame } from '../bench/game.js';
import { loadConfig, toSpec } from '../config/load.js';
import { teamsForSeed } from '../engine/exact/battle-utils.js';
import { specFromId, type PolicySpec } from '../engine/exact/policies.js';
import { percentile, readTurnMeter, resetTurnMeter } from './turn-meter.js';

const SHOWDOWN_START_S = 150;
const args = process.argv.slice(2);
const games = Math.max(2, Number(args.find(arg => /^\d+$/.test(arg)) ?? 20));
const opponentFlag = readFlag(args, '--opponent') ?? 'exact';
const pairs = Math.ceil(games / 2);
const challenger = toSpec(loadConfig('configs/strategist.yaml'), 'ladder');
const champion = opponentSpec(opponentFlag);
const key = Boolean(process.env.VERCEL_AI_GATEWAY_KEY || process.env.AI_GATEWAY_API_KEY);

resetTurnMeter();
let wins = 0;
let losses = 0;
let ties = 0;
let invalid = 0;
let crashes = 0;
const times: number[] = [];

console.log(`strategist engine screen games=${pairs * 2} opponent=${opponentFlag} apiKey=${key}`);

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

const played = wins + losses + ties;
const rate = played ? (wins + ties * 0.5) / played : 0;
const wilson = wilson95(rate, played);
const meter = readTurnMeter();
const attempts = meter.grokCalls + meter.grokTimeouts + meter.grokErrors;
const p50 = percentile(times, 0.5);
const p99 = percentile(times, 0.99);

console.log(JSON.stringify({
  opponent: opponentFlag,
  games: played,
  wins,
  losses,
  ties,
  record: `${wins}-${losses}-${ties}`,
  winRate: rate,
  wilson95: wilson,
  invalid,
  crashes,
  turns: meter.turns,
  grokCalls: meter.grokCalls,
  grokCallsPerGame: played ? meter.grokCalls / played : 0,
  grokTimeouts: meter.grokTimeouts,
  grokErrors: meter.grokErrors,
  grokAttempts: attempts,
  grokAttemptsPerGame: played ? attempts / played : 0,
  grokTimeoutRate: attempts ? meter.grokTimeouts / attempts : 0,
  grokP50Ms: percentile(meter.grokMs, 0.5),
  grokP99Ms: percentile(meter.grokMs, 0.99),
  jevCalls: meter.jevCalls,
  jevCallsPerGame: played ? meter.jevCalls / played : 0,
  vetoes: meter.vetoes,
  fallbacks: meter.fallbacks,
  p50Ms: p50,
  p99Ms: p99,
  showdownStartSeconds: SHOWDOWN_START_S,
  decisionBudgetMs: challenger.config.search.params.timeBudgetMs,
  p99Under15s: p99 <= 15_000,
  p50Under8s: p50 <= 8_000,
  promptTokens: meter.promptTokens,
  outputTokens: meter.outputTokens,
  reasoningTokens: meter.reasoningTokens,
  costUsd: meter.costUsd,
  costPerGame: played ? meter.costUsd / played : 0,
  plans: meter.plans,
  apiKey: key,
}, null, 2));

function opponentSpec(name: string): PolicySpec {
  if (name === 'exact' || name === '1ply' || name === 'champion') return specFromId('champion-exact-1ply');
  if (name === 'max-damage' || name === 'maxdamage') return specFromId('maxdamage-v1');
  if (name === 'random') return specFromId('random');
  throw new Error(`Unknown opponent "${name}". Use exact, max-damage, or random.`);
}

function readFlag(argv: string[], flag: string): string | undefined {
  const eq = argv.find(arg => arg.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const index = argv.indexOf(flag);
  if (index >= 0) return argv[index + 1];
  return undefined;
}

function wilson95(rate: number, n: number): [number, number] {
  const z = 1.96;
  const denom = 1 + (z * z) / Math.max(1, n);
  const center = (rate + (z * z) / (2 * Math.max(1, n))) / denom;
  const margin = (z * Math.sqrt((rate * (1 - rate)) / Math.max(1, n) + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}
