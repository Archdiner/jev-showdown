/**
 * Fit the switch model on high-Elo replay logs.
 *
 * Dev and held-out are split by replay id before any weight is updated.
 * Held-out rows are not printed. The feature list, L2, step size, and
 * epoch count are fixed here and are not changed after seeing held-out.
 *
 *   node dist/engine/exact/fit-switch-model.js
 */
import fs from 'fs';
import path from 'path';
import { Dex } from '@pkmn/sim';
import { SWITCH_FEATURES, featureVector, meanBenchHazard, publicMatchup, speciesLevel } from './matchup.js';

const LAMBDA = 1;
const LEARNING_RATE = 0.05;
const EPOCHS = 200;
const MIN_RATING = 1800;
const PAGES = 8;
const BASELINE_SWITCH_PROB = 1e-6;

interface Example {
  features: number[];
  switched: number;
}

interface Mon {
  species: string;
  level: number;
  hpFrac: number;
  moves: string[];
  fainted: boolean;
}

function splitOf(id: string): 'dev' | 'heldout' {
  const digits = Number(id.replace(/\D/g, ''));
  return Number.isFinite(digits) && digits % 2 === 0 ? 'dev' : 'heldout';
}

function sigmoid(logit: number): number {
  if (logit > 30) return 1;
  if (logit < -30) return 0;
  return 1 / (1 + Math.exp(-logit));
}

function dot(weights: number[], features: number[]): number {
  let total = 0;
  for (let i = 0; i < weights.length; i++) total += weights[i] * (features[i] || 0);
  return total;
}

function speciesOf(details: string): { species: string; level: number } {
  const name = details.split(',')[0].trim();
  const level = Number(details.match(/L(\d+)/)?.[1] || 0);
  const species = Dex.species.get(name).name || name;
  return { species, level: level || speciesLevel(species) };
}

function parseHp(text: string): number {
  if (!text || text.includes('fnt')) return 0;
  const match = text.match(/(\d+)\/(\d+)/);
  if (!match) return 1;
  const max = Number(match[2]);
  if (max <= 0) return 0;
  return Number(match[1]) / max;
}

function sideOf(token: string): 'p1' | 'p2' | null {
  if (token.startsWith('p1')) return 'p1';
  if (token.startsWith('p2')) return 'p2';
  return null;
}

function examplesFromLog(log: string): Example[] {
  const team: Record<'p1' | 'p2', Map<string, Mon>> = { p1: new Map(), p2: new Map() };
  const lines = log.split('\n');
  for (const line of lines) {
    const switched = line.match(/^\|(?:switch|drag|replace)\|p([12])a: [^|]*\|([^|]+)\|/);
    if (!switched) continue;
    const side = switched[1] === '1' ? 'p1' : 'p2';
    const { species, level } = speciesOf(switched[2]);
    if (!team[side].has(species)) team[side].set(species, { species, level, hpFrac: 1, moves: [], fainted: false });
  }

  const active: Record<'p1' | 'p2', string> = { p1: '', p2: '' };
  const hazards: Record<'p1' | 'p2', { rocks: boolean; spikes: number }> = {
    p1: { rocks: false, spikes: 0 },
    p2: { rocks: false, spikes: 0 },
  };
  const mustSwitch: Record<'p1' | 'p2', boolean> = { p1: false, p2: false };
  let weather = '';
  let turnSnapshot: Record<'p1' | 'p2', Mon | null> | null = null;
  let turnHazards: Record<'p1' | 'p2', { rocks: boolean; spikes: number }> | null = null;
  let turnWeather = '';
  const examples: Example[] = [];
  const decided = new Set<string>();

  const snapshot = (): Record<'p1' | 'p2', Mon | null> => ({
    p1: active.p1 ? { ...team.p1.get(active.p1)!, moves: [...(team.p1.get(active.p1)?.moves || [])] } : null,
    p2: active.p2 ? { ...team.p2.get(active.p2)!, moves: [...(team.p2.get(active.p2)?.moves || [])] } : null,
  });

  for (const line of lines) {
    if (line.startsWith('|turn|')) {
      turnSnapshot = snapshot();
      turnHazards = {
        p1: { ...hazards.p1 },
        p2: { ...hazards.p2 },
      };
      turnWeather = weather;
      decided.clear();
      continue;
    }
    const weatherLine = line.match(/^\|-weather\|([^|[\s]+)/);
    if (weatherLine) {
      const name = weatherLine[1].toLowerCase();
      weather = name === 'none' ? '' : name;
      continue;
    }
    const hazardStart = line.match(/^\|-sidestart\|(p[12]): .*\|(?:move: )?(Stealth Rock|Spikes)/);
    if (hazardStart) {
      const side = sideOf(hazardStart[1]);
      if (side && hazardStart[2] === 'Stealth Rock') hazards[side].rocks = true;
      if (side && hazardStart[2] === 'Spikes') hazards[side].spikes = Math.min(3, hazards[side].spikes + 1);
      continue;
    }
    const hazardEnd = line.match(/^\|-sideend\|(p[12]): .*\|(?:move: )?(Stealth Rock|Spikes)/);
    if (hazardEnd) {
      const side = sideOf(hazardEnd[1]);
      if (side && hazardEnd[2] === 'Stealth Rock') hazards[side].rocks = false;
      if (side && hazardEnd[2] === 'Spikes') hazards[side].spikes = 0;
      continue;
    }
    const faint = line.match(/^\|faint\|(p[12])a:/);
    if (faint) {
      const side = sideOf(faint[1]);
      if (!side) continue;
      mustSwitch[side] = true;
      const mon = team[side].get(active[side]);
      if (mon) {
        mon.fainted = true;
        mon.hpFrac = 0;
      }
      continue;
    }
    const damage = line.match(/^\|-damage\|(p[12])a: [^|]*\|([^|]*)/);
    if (damage) {
      const side = sideOf(damage[1]);
      if (!side) continue;
      const mon = team[side].get(active[side]);
      if (mon) mon.hpFrac = parseHp(damage[2]);
      continue;
    }
    const moved = line.match(/^\|move\|(p[12])a: [^|]*\|([^|]+)\|/);
    if (moved) {
      const side = sideOf(moved[1]);
      if (!side) continue;
      const mon = team[side].get(active[side]);
      const move = Dex.moves.get(moved[2]).id;
      if (mon && move && !mon.moves.includes(move)) mon.moves.push(move);
      if (turnSnapshot && !mustSwitch[side] && !decided.has(side)) {
        const example = exampleFor(side, turnSnapshot, team, turnHazards || hazards, turnWeather, 0);
        if (example) examples.push(example);
        decided.add(side);
      }
      continue;
    }
    const drag = line.match(/^\|drag\|(p[12])a:/);
    if (drag) {
      const side = sideOf(drag[1]);
      if (side) mustSwitch[side] = false;
    }
    const switched = line.match(/^\|(switch|drag|replace)\|(p[12])a: [^|]*\|([^|,]+)/);
    if (switched) {
      const side = sideOf(switched[2]);
      if (!side) continue;
      const { species, level } = speciesOf(switched[3]);
      const hp = line.split('|')[4] || '';
      const mon = team[side].get(species) || { species, level, hpFrac: 1, moves: [], fainted: false };
      mon.level = level;
      mon.hpFrac = parseHp(hp);
      mon.fainted = false;
      team[side].set(species, mon);
      const voluntary = switched[1] === 'switch' && turnSnapshot && !mustSwitch[side] && !decided.has(side);
      if (voluntary) {
        const example = exampleFor(side, turnSnapshot!, team, turnHazards || hazards, turnWeather, 1);
        if (example) examples.push(example);
        decided.add(side);
      }
      mustSwitch[side] = false;
      active[side] = species;
    }
  }
  return examples;
}

function exampleFor(
  side: 'p1' | 'p2',
  snap: Record<'p1' | 'p2', Mon | null>,
  team: Record<'p1' | 'p2', Map<string, Mon>>,
  hazards: Record<'p1' | 'p2', { rocks: boolean; spikes: number }>,
  weather: string,
  switched: number,
): Example | null {
  const our = snap[side];
  const foeSide = side === 'p1' ? 'p2' : 'p1';
  const foe = snap[foeSide];
  if (!our || !foe || our.hpFrac <= 0 || foe.hpFrac <= 0) return null;
  const match = publicMatchup({
    ourSpecies: our.species,
    ourLevel: our.level,
    ourHpFrac: our.hpFrac,
    ourMoves: our.moves,
    foeSpecies: foe.species,
    foeLevel: foe.level,
    foeHpFrac: foe.hpFrac,
    foeMoves: foe.moves,
    weather,
  });
  let best = match.margin;
  const benchSpecies: string[] = [];
  for (const mon of team[side].values()) {
    if (mon.species === our.species || mon.fainted) continue;
    benchSpecies.push(mon.species);
    const bench = publicMatchup({
      ourSpecies: mon.species,
      ourLevel: mon.level,
      ourHpFrac: mon.hpFrac,
      ourMoves: mon.moves,
      foeSpecies: foe.species,
      foeLevel: foe.level,
      foeHpFrac: foe.hpFrac,
      foeMoves: foe.moves,
      weather,
    });
    if (bench.margin > best) best = bench.margin;
  }
  return {
    switched,
    features: featureVector({
      foeThreat: match.foeThreat,
      ourThreat: match.ourThreat,
      outspeed: match.outspeed,
      benchMargin: best - match.margin,
      hazard: meanBenchHazard(benchSpecies, hazards[side].rocks, hazards[side].spikes),
      ourHpFrac: our.hpFrac,
      foeHpFrac: foe.hpFrac,
    }),
  };
}

function fit(examples: Example[]): number[] {
  const weights = new Array(SWITCH_FEATURES.length).fill(0);
  const n = examples.length || 1;
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    const grad = new Array(weights.length).fill(0);
    for (const example of examples) {
      const error = sigmoid(dot(weights, example.features)) - example.switched;
      for (let i = 0; i < weights.length; i++) grad[i] += error * example.features[i];
    }
    for (let i = 0; i < weights.length; i++) {
      const penalty = i === 0 ? 0 : LAMBDA * weights[i];
      weights[i] -= LEARNING_RATE * (grad[i] / n + penalty);
    }
  }
  return weights;
}

function score(examples: Example[], weights: number[]): {
  n: number;
  switchRate: number;
  logLoss: number;
  baselineLogLoss: number;
  accuracy: number;
  baselineAccuracy: number;
} {
  let loss = 0;
  let baseline = 0;
  let correct = 0;
  let switches = 0;
  for (const example of examples) {
    const p = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(dot(weights, example.features))));
    const y = example.switched;
    loss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    const baseP = y === 1 ? BASELINE_SWITCH_PROB : 1 - BASELINE_SWITCH_PROB;
    baseline += -Math.log(baseP);
    if ((p >= 0.5 ? 1 : 0) === y) correct++;
    switches += y;
  }
  const n = examples.length || 1;
  return {
    n: examples.length,
    switchRate: switches / n,
    logLoss: loss / n,
    baselineLogLoss: baseline / n,
    accuracy: correct / n,
    baselineAccuracy: (examples.length - switches) / n,
  };
}

const CACHE_PATH = path.join(process.cwd(), 'data', 'replays', 'switch-fit-cache.jsonl');

async function fetchJson(url: string): Promise<any | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url);
    if (response.status === 429 || response.status >= 500) {
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      continue;
    }
    if (!response.ok) return null;
    return response.json();
  }
  return null;
}

function loadCache(): Array<{ id: string; rating: number; log: string }> {
  if (!fs.existsSync(CACHE_PATH)) return [];
  const rows: Array<{ id: string; rating: number; log: string }> = [];
  for (const line of fs.readFileSync(CACHE_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { id: string; rating: number; log: string };
    if (row.log) rows.push(row);
  }
  return rows;
}

async function fetchReplays(): Promise<Array<{ id: string; rating: number; log: string }>> {
  const cached = loadCache();
  if (cached.length > 0) {
    console.log(`cache ${cached.length} replays from ${CACHE_PATH}`);
    return cached;
  }
  const found: Array<{ id: string; rating: number; log: string }> = [];
  const seen = new Set<string>();
  let before: number | undefined;
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  for (let page = 0; page < PAGES; page++) {
    const url = new URL('https://replay.pokemonshowdown.com/search.json');
    url.searchParams.set('format', 'gen9randombattle');
    if (before) url.searchParams.set('before', String(before));
    const rows = await fetchJson(url.toString()) as Array<{ id: string; rating: number | null; uploadtime: number }> | null;
    if (!rows?.length) break;
    before = rows[rows.length - 1].uploadtime;
    for (const row of rows) {
      if (!row.id || seen.has(row.id) || typeof row.rating !== 'number' || row.rating < MIN_RATING) continue;
      seen.add(row.id);
      const body = await fetchJson(`https://replay.pokemonshowdown.com/${row.id}.json`) as { log?: string } | null;
      if (!body?.log) continue;
      const saved = { id: row.id, rating: row.rating, log: body.log };
      found.push(saved);
      fs.appendFileSync(CACHE_PATH, JSON.stringify(saved) + '\n');
    }
    console.log(`page ${page + 1}: ${found.length} replays rated >= ${MIN_RATING}`);
  }
  return found;
}

function featureMeans(examples: Example[]): number[] {
  const means = new Array(SWITCH_FEATURES.length).fill(0);
  for (const example of examples) {
    for (let i = 0; i < means.length; i++) means[i] += example.features[i] || 0;
  }
  const n = examples.length || 1;
  return means.map(value => value / n);
}

function format(name: string, value: ReturnType<typeof score>): string {
  return [
    `${name} n=${value.n} switch-rate ${(value.switchRate * 100).toFixed(1)}%`,
    `logloss ${value.logLoss.toFixed(4)} baseline ${value.baselineLogLoss.toFixed(4)}`,
    `accuracy ${(value.accuracy * 100).toFixed(1)}% baseline ${(value.baselineAccuracy * 100).toFixed(1)}%`,
  ].join('\n');
}

async function main(): Promise<void> {
  const replays = await fetchReplays();
  const buckets: Record<'dev' | 'heldout', Example[]> = { dev: [], heldout: [] };
  for (const replay of replays) {
    const split = splitOf(replay.id);
    try {
      buckets[split].push(...examplesFromLog(replay.log));
    } catch {
      // A log we cannot parse is not an example.
    }
  }
  console.log(`examples dev=${buckets.dev.length} heldout=${buckets.heldout.length}`);
  const means = featureMeans(buckets.dev);
  if (means.some(value => !Number.isFinite(value))) {
    throw new Error('dev features are not finite; held-out was not scored');
  }
  console.log(`dev feature means ${SWITCH_FEATURES.map((name, i) => `${name}=${means[i].toFixed(3)}`).join(' ')}`);
  const weights = fit(buckets.dev);
  const dev = score(buckets.dev, weights);
  console.log(format('dev', dev));
  console.log(`weights ${weights.map(value => value.toFixed(3)).join(' ')}`);
  if (process.env.SWITCH_FIT_DEV_ONLY === '1') {
    console.log('dev-only: held-out was not scored');
    return;
  }
  const held = score(buckets.heldout, weights);

  console.log(format('heldout', held));

  const payload = {
    features: [...SWITCH_FEATURES],
    weights,
    lambda: LAMBDA,
    epochs: EPOCHS,
    learningRate: LEARNING_RATE,
    dev,
    heldout: held,
    replays: replays.length,
  };
  const modelPath = path.join(process.cwd(), 'src', 'engine', 'exact', 'switch-weights.json');
  fs.writeFileSync(modelPath, JSON.stringify({
    features: payload.features,
    weights: payload.weights,
    lambda: payload.lambda,
    epochs: payload.epochs,
    learningRate: payload.learningRate,
  }, null, 2));
  const reportDir = path.join(process.cwd(), 'state', 'models');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'switch-fit.json'), JSON.stringify(payload, null, 2));
  console.log(`wrote ${modelPath}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
