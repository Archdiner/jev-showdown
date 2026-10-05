/**
 * Generated position sets.
 *
 * Dev seeds start at 2000. Held-out seeds start at 800000. Those ranges were
 * fixed before any agreement number was computed. Do not retune them, and do
 * not open held-out positions to change the bot.
 *
 * A label is either the only move that wins against every legal reply, or the
 * choice of a depth-2 exact search. Nothing here is labeled by hand.
 *
 * Run from the compiled output so the labeling workers resolve:
 *   node dist/engine/exact/position-sets.js generate
 *   node dist/engine/exact/position-sets.js score dev
 *   node dist/engine/exact/position-sets.js score heldout
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isMainThread, Worker } from 'worker_threads';
import { Battle, PRNG } from '@pkmn/sim';
import {
  SideId,
  cloneFromSnapshot,
  legalChoices,
  otherSide,
  playChoices,
  safeChoose,
  snapshot,
  startRandomBattle,
  teamsForSeed,
} from './battle-utils.js';
import { maxDamageChoice } from './max-damage.js';
import { EXACT_1PLY, ExactConfig, exactSearch } from './search.js';

export const SPLITS = {
  dev: { seedStart: 2_000, count: 200 },
  heldout: { seedStart: 800_000, count: 200 },
} as const;

export type SplitName = keyof typeof SPLITS;

/** Deeper than the 1-ply candidate. Frozen with the position file. */
export const LABELER: ExactConfig = {
  depth: 2,
  opponentModel: 'max-damage',
  evalMode: 'hp',
  errorAsLoss: false,
  samples: 1,
};

const FORCED_WIN_SAMPLES = 2;
const REPLAY_MIN_RATING = 1800;
const REPLAY_PAGES = 6;

export interface SavedPosition {
  id: string;
  source: 'random' | 'replay';
  seed: number;
  turn: number;
  side: SideId;
  snapshot: string;
  legal: string[];
  label: string;
  labelKind: 'forced-win' | 'deep-search';
  replayId?: string;
  rating?: number;
}

export interface PositionFile {
  version: 1;
  split: SplitName;
  inspect: boolean;
  labeler: ExactConfig;
  positions: SavedPosition[];
}

export interface Agreement {
  hit: number;
  total: number;
}

export interface SplitScore {
  split: SplitName;
  positions: number;
  replayPositions: number;
  forcedWin: Agreement;
  deepAgree: Agreement;
  maxDamageDeepAgree: Agreement;
}

function reseed(battle: Battle, sample: number): void {
  const prng = new PRNG([sample + 1, 0x6d2b79f5, 0x1b873593, 0x85ebca6b] as any);
  battle.resetRNG(prng.startingSeed);
}

function filePath(split: SplitName): string {
  return path.join(process.cwd(), 'state', 'positions', `${split}.json`);
}

export function loadSplit(split: SplitName): PositionFile {
  const raw = fs.readFileSync(filePath(split), 'utf8');
  return JSON.parse(raw) as PositionFile;
}

function wins(battle: Battle, side: SideId): boolean {
  if (!battle.ended || !battle.winner) return false;
  return battle.winner === battle.getSide(side).name;
}

function uniqueForcedWin(snap: string, side: SideId): string | null {
  const root = cloneFromSnapshot(snap);
  const mine = legalChoices(root, side).filter(choice => choice.startsWith('move') || choice.startsWith('switch'));
  const oppChoices = legalChoices(root, otherSide(side));
  if (mine.length < 2 || mine.length > 8 || oppChoices.length > 8) return null;
  const replies = oppChoices.length > 0 ? oppChoices : [undefined];

  const forced: string[] = [];
  for (const choice of mine) {
    let always = true;
    for (let sample = 0; sample < FORCED_WIN_SAMPLES && always; sample++) {
      for (const reply of replies) {
        const battle = cloneFromSnapshot(snap);
        reseed(battle, 50 + sample);
        playChoices(battle, side, choice, reply);
        if (!wins(battle, side)) {
          always = false;
          break;
        }
      }
    }
    if (always) forced.push(choice);
  }
  return forced.length === 1 ? forced[0] : null;
}

function labelSnapshot(snap: string, side: SideId): { label: string; labelKind: SavedPosition['labelKind'] } {
  const forced = uniqueForcedWin(snap, side);
  if (forced) return { label: forced, labelKind: 'forced-win' };
  const battle = cloneFromSnapshot(snap);
  const trace = exactSearch(battle, side, LABELER);
  return { label: trace.choice, labelKind: 'deep-search' };
}

export function takeRandomPosition(seed: number): SavedPosition | null {
  const teams = teamsForSeed(seed);
  const battle = startRandomBattle(teams.p1, teams.p2, seed);
  for (let guard = 0; guard < 50 && !battle.ended; guard++) {
    const p1 = legalChoices(battle, 'p1');
    const p2 = legalChoices(battle, 'p2');
    const ready = battle.turn >= 2 && p1.length >= 2 && p2.length >= 2 && p1.some(choice => choice.startsWith('move'));
    if (ready) {
      const snap = snapshot(battle);
      const labeled = labelSnapshot(snap, 'p1');
      return {
        id: `random-${seed}`,
        source: 'random',
        seed,
        turn: battle.turn,
        side: 'p1',
        snapshot: snap,
        legal: p1,
        label: labeled.label,
        labelKind: labeled.labelKind,
      };
    }
    if (p1.length) safeChoose(battle, 'p1', maxDamageChoice(battle, 'p1', p1));
    if (!battle.ended && p2.length) safeChoose(battle, 'p2', maxDamageChoice(battle, 'p2', p2));
  }
  return null;
}

interface ReplayMeta {
  id: string;
  rating: number | null;
}

function activesAtTurn(log: string): Map<number, { p1: string; p2: string }> {
  let p1 = '';
  let p2 = '';
  const turns = new Map<number, { p1: string; p2: string }>();
  for (const line of log.split('\n')) {
    const switched = line.match(/^\|(?:switch|drag|replace)\|p([12])a: [^|]*\|([^|,]+)/);
    if (switched) {
      const species = switched[2].trim();
      if (switched[1] === '1') p1 = species;
      else p2 = species;
    }
    const turn = line.match(/^\|turn\|(\d+)/);
    if (turn && p1 && p2) turns.set(Number(turn[1]), { p1, p2 });
  }
  return turns;
}

function speciesOnField(battle: Battle, side: SideId): string {
  return battle.getSide(side).active[0]?.species.name || '';
}

async function mineReplay(meta: ReplayMeta): Promise<SavedPosition | null> {
  const response = await fetch(`https://replay.pokemonshowdown.com/${meta.id}.json`);
  if (!response.ok) return null;
  const body = await response.json() as { log?: string; inputlog?: string };
  if (!body.log || !body.inputlog) return null;
  const expected = activesAtTurn(body.log);
  const lines = body.inputlog.split('\n').filter(Boolean);
  const startLine = lines.find(line => line.startsWith('>start '));
  if (!startLine) return null;
  const start = JSON.parse(startLine.slice(7)) as { formatid?: string; seed?: string };
  if (start.formatid !== 'gen9randombattle' || !start.seed) return null;

  const { Teams } = await import('@pkmn/sim');
  const { TeamGenerators } = await import('@pkmn/randoms');
  Teams.setGeneratorFactory(TeamGenerators);
  const battle = new Battle({ formatid: 'gen9randombattle' as any, seed: start.seed as any });
  let saved: SavedPosition | null = null;

  for (const line of lines) {
    if (line.startsWith('>version') || line.startsWith('>start')) continue;
    if (line.startsWith('>player ')) {
      const rest = line.slice('>player '.length);
      const space = rest.indexOf(' ');
      const id = rest.slice(0, space) as SideId;
      battle.setPlayer(id, JSON.parse(rest.slice(space + 1)));
      continue;
    }
    const match = line.match(/^>(p[12]) (.*)$/);
    if (!match) continue;

    if (battle.turn >= 1) {
      const seen = expected.get(battle.turn);
      const faithful = !!seen
        && speciesOnField(battle, 'p1') === seen.p1
        && speciesOnField(battle, 'p2') === seen.p2;
      if (!faithful) return saved;
      const legal = legalChoices(battle, 'p1');
      if (!saved && legal.length >= 2 && legal.some(choice => choice.startsWith('move'))) {
        const snap = snapshot(battle);
        const labeled = labelSnapshot(snap, 'p1');
        saved = {
          id: `replay-${meta.id}`,
          source: 'replay',
          seed: 0,
          turn: battle.turn,
          side: 'p1',
          snapshot: snap,
          legal,
          label: labeled.label,
          labelKind: labeled.labelKind,
          replayId: meta.id,
          rating: meta.rating ?? undefined,
        };
      }
    }

    let ok = false;
    try {
      ok = battle.choose(match[1] as SideId, match[2]);
    } catch {
      return saved;
    }
    if (!ok) return saved;
  }
  return saved;
}

async function fetchHighEloReplays(): Promise<ReplayMeta[]> {
  const found: ReplayMeta[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= REPLAY_PAGES; page++) {
    const response = await fetch(`https://replay.pokemonshowdown.com/search.json?format=gen9randombattle&page=${page}`);
    if (!response.ok) break;
    const rows = await response.json() as ReplayMeta[];
    for (const row of rows) {
      if (!row.id || seen.has(row.id)) continue;
      if (typeof row.rating !== 'number' || row.rating < REPLAY_MIN_RATING) continue;
      seen.add(row.id);
      found.push(row);
    }
  }
  return found;
}

function replaySplit(id: string): SplitName {
  const digits = Number(id.replace(/\D/g, ''));
  return digits % 2 === 0 ? 'dev' : 'heldout';
}

interface LabelMessage {
  ok: boolean;
  position?: SavedPosition | null;
  error?: string;
}

function labelSeeds(seeds: number[]): Promise<Array<SavedPosition | null>> {
  const workerCount = Math.max(1, Math.min(os.cpus().length, seeds.length));
  const workers = Array.from({ length: workerCount }, () => new Worker(new URL('./position-worker.js', import.meta.url)));
  const results: Array<SavedPosition | null> = new Array(seeds.length);
  let cursor = 0;
  let finished = 0;

  const done = new Promise<Array<SavedPosition | null>>((resolve, reject) => {
    let failed = false;
    const fail = (err: Error) => {
      if (failed) return;
      failed = true;
      reject(err);
    };
    const assign = (worker: Worker) => {
      if (failed || cursor >= seeds.length) return;
      const index = cursor++;
      const seed = seeds[index];
      const onMessage = (msg: LabelMessage) => {
        worker.off('message', onMessage);
        if (!msg.ok) {
          fail(new Error(msg.error || `seed ${seed} failed`));
          return;
        }
        results[index] = msg.position ?? null;
        finished++;
        if (finished % 25 === 0 || finished === seeds.length) {
          console.log(`  labeled ${finished}/${seeds.length}`);
        }
        if (finished === seeds.length) {
          resolve(results);
          return;
        }
        assign(worker);
      };
      worker.on('message', onMessage);
      worker.postMessage({ seed });
    };
    for (const worker of workers) {
      worker.on('error', err => fail(err));
      assign(worker);
    }
  });

  return done.finally(() => Promise.all(workers.map(worker => worker.terminate())));
}

export async function generateSplits(): Promise<void> {
  const dir = path.join(process.cwd(), 'state', 'positions');
  fs.mkdirSync(dir, { recursive: true });
  const buckets: Record<SplitName, SavedPosition[]> = { dev: [], heldout: [] };
  const jobs: Array<{ split: SplitName; seed: number }> = [];

  for (const split of Object.keys(SPLITS) as SplitName[]) {
    const range = SPLITS[split];
    console.log(`sampling ${split} seeds ${range.seedStart}..${range.seedStart + range.count - 1}`);
    for (let i = 0; i < range.count; i++) jobs.push({ split, seed: range.seedStart + i });
  }

  const labeled = await labelSeeds(jobs.map(job => job.seed));
  for (let i = 0; i < jobs.length; i++) {
    const position = labeled[i];
    if (position) buckets[jobs[i].split].push(position);
  }

  try {
    const replays = await fetchHighEloReplays();
    console.log(`high-Elo replays fetched: ${replays.length} (rating >= ${REPLAY_MIN_RATING})`);
    for (const replay of replays) {
      const split = replaySplit(replay.id);
      try {
        const position = await mineReplay(replay);
        if (position) buckets[split].push(position);
      } catch {
        // A replay that this sim cannot step is not a position.
      }
    }
  } catch (error) {
    console.log(`replay fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const split of Object.keys(SPLITS) as SplitName[]) {
    const file: PositionFile = {
      version: 1,
      split,
      inspect: split === 'dev',
      labeler: LABELER,
      positions: buckets[split],
    };
    fs.writeFileSync(filePath(split), JSON.stringify(file));
    const replays = buckets[split].filter(position => position.source === 'replay').length;
    const forced = buckets[split].filter(position => position.labelKind === 'forced-win').length;
    console.log(`wrote ${split}: ${buckets[split].length} positions, ${forced} forced wins, ${replays} faithful replays`);
  }
}

function choiceFor(kind: 'search' | 'maxdamage', battle: Battle, side: SideId): string {
  const legal = legalChoices(battle, side);
  if (kind === 'maxdamage') return maxDamageChoice(battle, side, legal);
  return exactSearch(battle, side, EXACT_1PLY).choice;
}

export function scoreSplit(split: SplitName): SplitScore {
  const file = loadSplit(split);
  const score: SplitScore = {
    split,
    positions: file.positions.length,
    replayPositions: file.positions.filter(position => position.source === 'replay').length,
    forcedWin: { hit: 0, total: 0 },
    deepAgree: { hit: 0, total: 0 },
    maxDamageDeepAgree: { hit: 0, total: 0 },
  };

  for (const position of file.positions) {
    const battle = cloneFromSnapshot(position.snapshot);
    const searchChoice = choiceFor('search', battle, position.side);
    const heuristic = choiceFor('maxdamage', cloneFromSnapshot(position.snapshot), position.side);
    if (position.labelKind === 'forced-win') {
      score.forcedWin.total++;
      if (searchChoice === position.label) score.forcedWin.hit++;
    } else {
      score.deepAgree.total++;
      if (searchChoice === position.label) score.deepAgree.hit++;
      score.maxDamageDeepAgree.total++;
      if (heuristic === position.label) score.maxDamageDeepAgree.hit++;
    }
  }
  return score;
}

export function heldOutPasses(score: SplitScore): { ok: boolean; reason: string } {
  if (score.split !== 'heldout') return { ok: false, reason: 'not the held-out split' };
  if (score.positions < 100) return { ok: false, reason: `held-out set has ${score.positions} positions` };
  if (score.forcedWin.total > 0 && score.forcedWin.hit < score.forcedWin.total) {
    return {
      ok: false,
      reason: `held-out forced-win ${score.forcedWin.hit}/${score.forcedWin.total}`,
    };
  }
  if (score.deepAgree.total === 0) return { ok: false, reason: 'held-out deep-search slice is empty' };
  const searchRate = score.deepAgree.hit / score.deepAgree.total;
  const heuristicRate = score.maxDamageDeepAgree.hit / score.maxDamageDeepAgree.total;
  if (searchRate < heuristicRate) {
    return {
      ok: false,
      reason: `held-out agreement ${(searchRate * 100).toFixed(1)}% is below max-damage ${(heuristicRate * 100).toFixed(1)}%`,
    };
  }
  return {
    ok: true,
    reason: `held-out forced-win ${score.forcedWin.hit}/${score.forcedWin.total}, deep agreement ${(searchRate * 100).toFixed(1)}% vs max-damage ${(heuristicRate * 100).toFixed(1)}% (${score.replayPositions} replay positions)`,
  };
}

function percent(part: Agreement): string {
  if (part.total === 0) return 'n/a';
  return `${((part.hit / part.total) * 100).toFixed(1)}% (${part.hit}/${part.total})`;
}

export function formatScore(score: SplitScore): string {
  return [
    `split=${score.split} positions=${score.positions} replays=${score.replayPositions}`,
    `forced-win ${percent(score.forcedWin)}`,
    `deep agreement ${percent(score.deepAgree)}`,
    `max-damage deep agreement ${percent(score.maxDamageDeepAgree)}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'generate') {
    await generateSplits();
    return;
  }
  if (command === 'score') {
    const split = process.argv[3] as SplitName;
    if (split !== 'dev' && split !== 'heldout') throw new Error('score dev|heldout');
    const score = scoreSplit(split);
    console.log(formatScore(score));
    if (split === 'heldout') console.log(heldOutPasses(score).reason);
    return;
  }
  throw new Error('usage: position-sets.ts generate|score <dev|heldout>');
}

if (isMainThread && process.argv[1]?.includes('position-sets')) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
