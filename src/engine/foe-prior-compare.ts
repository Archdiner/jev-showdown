import * as fs from 'fs';
import { Battle } from '@pkmn/sim';
import { RandbatsStats } from '../types/index.js';
import { buildDecisionBattle, LivePosition } from '../client/decision-battle.js';
import {
  legalChoices,
  otherSide,
  SideId,
  startRandomBattle,
  teamsForSeed,
} from './exact/battle-utils.js';
import { EXACT_1PLY, ExactConfig, exactSearch } from './exact/search.js';

/**
 * Hidden-information games. Each side only sees species, moves, items, and
 * abilities that have appeared in the battle log. `prior` fills the rest
 * from the randbats table. `revealed` keeps today's Tackle-and-no-bench foe.
 * The same seed is played twice with the models swapped. `oracle` is exact
 * search on the real battle, which still knows both teams.
 */

type ModelName = 'prior' | 'revealed';

interface SeenMon {
  species: string;
  level: number;
  moves: string[];
  ability?: string;
  item?: string;
}

interface Book {
  cursor: number;
  sides: Record<SideId, Map<string, SeenMon>>;
  /** ident nickname -> species, so a later move line finds the right mon. */
  speciesOf: Map<string, string>;
}

export interface CompareOptions {
  /** Seeds. Each seed is played twice, with the prior model in each seat. */
  pairs: number;
  samples?: number;
  stats: RandbatsStats;
  oracle?: boolean;
  maxTurns?: number;
  seed?: number;
}

export interface LatencySummary {
  n: number;
  mean: number;
  p50: number;
  p95: number;
}

export interface CompareReport {
  pairs: number;
  games: number;
  samples: number;
  priorWins: number;
  revealedWins: number;
  ties: number;
  /** Prior wins divided by games that produced a winner. */
  priorWinRate: number | null;
  wilson95: [number, number] | null;
  invalidChoices: number;
  crashes: number;
  oracleAgreement: {
    priorDecisions: number;
    revealedDecisions: number;
    prior: number | null;
    revealed: number | null;
  };
  latencyMs: {
    prior: LatencySummary;
    revealed: LatencySummary;
  };
}

export async function compareFoePriors(options: CompareOptions): Promise<CompareReport> {
  const samples = options.samples ?? EXACT_1PLY.samples ?? 8;
  const config: ExactConfig = { ...EXACT_1PLY, samples };
  const oracle = options.oracle !== false;
  const maxTurns = options.maxTurns ?? 80;
  const origin = options.seed ?? 1;
  const priorMs: number[] = [];
  const revealedMs: number[] = [];
  let priorWins = 0;
  let revealedWins = 0;
  let ties = 0;
  let invalidChoices = 0;
  let crashes = 0;
  let priorOracleDecisions = 0;
  let revealedOracleDecisions = 0;
  let priorOracle = 0;
  let revealedOracle = 0;

  for (let i = 0; i < options.pairs; i++) {
    for (const priorSide of ['p1', 'p2'] as const) {
      try {
        const result = playGame(origin + i, priorSide, options.stats, config, oracle, maxTurns);
        if (result.winner === 'prior') priorWins++;
        else if (result.winner === 'revealed') revealedWins++;
        else ties++;
        invalidChoices += result.invalidChoices;
        priorMs.push(...result.priorMs);
        revealedMs.push(...result.revealedMs);
        priorOracleDecisions += result.priorOracleDecisions;
        revealedOracleDecisions += result.revealedOracleDecisions;
        priorOracle += result.priorOracle;
        revealedOracle += result.revealedOracle;
      } catch {
        crashes++;
        ties++;
      }
    }
  }

  const decided = priorWins + revealedWins;
  return {
    pairs: options.pairs,
    games: options.pairs * 2,
    samples,
    priorWins,
    revealedWins,
    ties,
    priorWinRate: decided > 0 ? priorWins / decided : null,
    wilson95: decided > 0 ? wilson(priorWins, decided) : null,
    invalidChoices,
    crashes,
    oracleAgreement: {
      priorDecisions: priorOracleDecisions,
      revealedDecisions: revealedOracleDecisions,
      prior: priorOracleDecisions > 0 ? priorOracle / priorOracleDecisions : null,
      revealed: revealedOracleDecisions > 0 ? revealedOracle / revealedOracleDecisions : null,
    },
    latencyMs: {
      prior: summarize(priorMs),
      revealed: summarize(revealedMs),
    },
  };
}

interface GameResult {
  winner: 'prior' | 'revealed' | 'tie';
  invalidChoices: number;
  priorMs: number[];
  revealedMs: number[];
  priorOracleDecisions: number;
  revealedOracleDecisions: number;
  priorOracle: number;
  revealedOracle: number;
}

function playGame(
  seed: number,
  priorSide: SideId,
  stats: RandbatsStats,
  config: ExactConfig,
  oracle: boolean,
  maxTurns: number,
): GameResult {
  const teams = teamsForSeed(seed);
  const battle = startRandomBattle(teams.p1, teams.p2, seed);
  const book = emptyBook();
  const priorMs: number[] = [];
  const revealedMs: number[] = [];
  let invalidChoices = 0;
  let priorOracleDecisions = 0;
  let revealedOracleDecisions = 0;
  let priorOracle = 0;
  let revealedOracle = 0;
  let guard = 0;

  while (!battle.ended && battle.turn < maxTurns && guard < maxTurns * 6) {
    guard++;
    consume(battle, book);
    const logBefore = battle.log.length;
    let acted = false;
    for (const side of ['p1', 'p2'] as const) {
      const model: ModelName = side === priorSide ? 'prior' : 'revealed';
      const picked = choose(battle, side, model, book, stats, config);
      if (!picked.choice) continue;
      acted = true;
      if (picked.ms > 0) (model === 'prior' ? priorMs : revealedMs).push(picked.ms);
      if (oracle && picked.searched) {
        const full = exactSearch(battle, side, config).choice;
        if (model === 'prior') {
          priorOracleDecisions++;
          if (picked.choice === full) priorOracle++;
        } else {
          revealedOracleDecisions++;
          if (picked.choice === full) revealedOracle++;
        }
      }
      const legal = legalChoices(battle, side);
      const choice = legal.includes(picked.choice) ? picked.choice : legal[0];
      if (choice !== picked.choice) invalidChoices++;
      if (!choice) continue;
      try {
        if (!battle.choose(side, choice)) invalidChoices++;
      } catch {
        invalidChoices++;
      }
    }
    if (!acted) break;
    // A knockout switch does not increment the turn. A choice that adds no
    // protocol line did not happen, and retrying it would spin.
    if (!battle.ended && battle.log.length === logBefore) break;
  }

  return {
    winner: winnerOf(battle, priorSide),
    invalidChoices,
    priorMs,
    revealedMs,
    priorOracleDecisions,
    revealedOracleDecisions,
    priorOracle,
    revealedOracle,
  };
}

function winnerOf(battle: Battle, priorSide: SideId): 'prior' | 'revealed' | 'tie' {
  if (!battle.ended || !battle.winner) return 'tie';
  const priorName = battle.getSide(priorSide).name;
  if (battle.winner === priorName) return 'prior';
  return 'revealed';
}

interface Pick {
  choice: string;
  ms: number;
  searched: boolean;
}

function choose(
  battle: Battle,
  side: SideId,
  model: ModelName,
  book: Book,
  stats: RandbatsStats,
  config: ExactConfig,
): Pick {
  const request = battle.getSide(side).activeRequest as { wait?: boolean; teamPreview?: boolean } | null;
  if (!request || request.wait) return { choice: '', ms: 0, searched: false };
  if (request.teamPreview) return { choice: 'default', ms: 0, searched: false };
  const position = partialPosition(battle, side, book);
  if (model === 'prior') position.speciesStats = stats;
  else position.modelHidden = false;
  const started = performance.now();
  const built = buildDecisionBattle(position, { budgetMs: 8000 });
  if (!built) {
    const legal = legalChoices(battle, side);
    return { choice: legal[0] || 'default', ms: performance.now() - started, searched: false };
  }
  const trace = exactSearch(built, 'p1', config);
  return { choice: trace.choice, ms: performance.now() - started, searched: true };
}

function partialPosition(battle: Battle, side: SideId, book: Book): LivePosition {
  const foeSide = battle.getSide(otherSide(side));
  const ourSide = battle.getSide(side);
  const seen = book.sides[otherSide(side)];
  const active = foeSide.active[0];
  const snap = (mon: typeof active, reveal: SeenMon | undefined) => {
    if (!mon) return null;
    return {
      species: mon.species.name,
      level: mon.level,
      hp: mon.hp,
      maxhp: mon.maxhp,
      status: mon.status || undefined,
      ability: reveal?.ability,
      item: reveal?.item,
      moves: reveal?.moves ? [...reveal.moves] : [],
      boosts: {
        atk: mon.boosts.atk,
        def: mon.boosts.def,
        spa: mon.boosts.spa,
        spd: mon.boosts.spd,
        spe: mon.boosts.spe,
      },
      fainted: mon.fainted || mon.hp <= 0,
    };
  };
  const foeActive = active
    ? snap(active, seen.get(active.species.name) ?? { species: active.species.name, level: active.level, moves: [] })
    : null;
  const foeBench = foeSide.pokemon
    .filter(mon => mon && mon !== active)
    .map(mon => {
      const reveal = seen.get(mon.species.name);
      if (!reveal) return null;
      return snap(mon, reveal);
    })
    .filter((mon): mon is NonNullable<typeof mon> => !!mon);
  const ours = ourSide.active[0];
  const weather = battle.field.weather ? String(battle.field.weather) : undefined;
  return {
    request: battle.getSide(side).activeRequest,
    foeActive,
    foeBench,
    ourBoosts: ours ? {
      atk: ours.boosts.atk,
      def: ours.boosts.def,
      spa: ours.boosts.spa,
      spd: ours.boosts.spd,
      spe: ours.boosts.spe,
    } : undefined,
    weather,
  };
}

function emptyBook(): Book {
  return { cursor: 0, sides: { p1: new Map(), p2: new Map() }, speciesOf: new Map() };
}

function consume(battle: Battle, book: Book): void {
  const log = battle.log;
  for (; book.cursor < log.length; book.cursor++) {
    const line = log[book.cursor];
    if (!line.startsWith('|')) continue;
    const parts = line.split('|');
    const cmd = parts[1];
    if (cmd === 'switch' || cmd === 'drag' || cmd === 'replace') {
      const who = whoOf(parts[2] || '');
      const details = parts[3] || '';
      if (!who) continue;
      const species = details.split(',')[0]?.trim() || who.nickname;
      const levelMatch = details.match(/L(\d+)/);
      book.speciesOf.set(`${who.side}:${who.nickname}`, species);
      const mon = ensure(book, who.side, species, levelMatch ? Number(levelMatch[1]) : 80);
      mon.species = species;
      if (levelMatch) mon.level = Number(levelMatch[1]);
      continue;
    }
    if (cmd === 'move') {
      const who = whoOf(parts[2] || '');
      const move = parts[3] || '';
      if (!who || !move || move === 'Recharge') continue;
      const mon = seenMon(book, who, who.nickname);
      if (!mon.moves.includes(move)) mon.moves.push(move);
      continue;
    }
    if (cmd === '-ability') {
      const who = whoOf(parts[2] || '');
      if (!who || !parts[3]) continue;
      seenMon(book, who, who.nickname).ability = parts[3];
      continue;
    }
    if (cmd === '-item' || cmd === '-enditem') {
      const who = whoOf(parts[2] || '');
      if (!who || !parts[3]) continue;
      seenMon(book, who, who.nickname).item = parts[3];
    }
  }
}

function seenMon(book: Book, who: { side: SideId; nickname: string }, fallback: string): SeenMon {
  const species = book.speciesOf.get(`${who.side}:${who.nickname}`) || fallback;
  return ensure(book, who.side, species, 80);
}

function ensure(book: Book, side: SideId, species: string, level: number): SeenMon {
  const map = book.sides[side];
  const existing = map.get(species);
  if (existing) return existing;
  const created: SeenMon = { species, level, moves: [] };
  map.set(species, created);
  return created;
}

function whoOf(ident: string): { side: SideId; nickname: string } | null {
  const side: SideId | null = ident.startsWith('p2') ? 'p2' : ident.startsWith('p1') ? 'p1' : null;
  if (!side) return null;
  const nickname = ident.split(':').slice(1).join(':').trim() || ident;
  return { side, nickname };
}

function summarize(values: number[]): LatencySummary {
  if (values.length === 0) return { n: 0, mean: 0, p50: 0, p95: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { n: values.length, mean, p50: percentile(values, 50), p95: percentile(values, 95) };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function wilson(wins: number, n: number, z = 1.96): [number, number] {
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function isDirectRun(): boolean {
  const entry = process.argv[1] || '';
  return entry.endsWith('foe-prior-compare.ts') || entry.endsWith('foe-prior-compare.js');
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

async function main(): Promise<void> {
  const statsPath = arg('--stats', 'data/gen9-stats.json');
  if (!fs.existsSync(statsPath)) {
    throw new Error(`missing ${statsPath}. Run npm run data:refresh first.`);
  }
  const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8')) as RandbatsStats;
  const report = await compareFoePriors({
    pairs: Number(arg('--pairs', '12')),
    samples: Number(arg('--samples', '8')),
    stats,
    oracle: !process.argv.includes('--no-oracle'),
    maxTurns: Number(arg('--max-turns', '80')),
    seed: Number(arg('--seed', '1')),
  });
  console.log(JSON.stringify(report, null, 2));
}

if (isDirectRun()) {
  main().catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
