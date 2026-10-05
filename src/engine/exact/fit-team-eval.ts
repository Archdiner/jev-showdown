/**
 * Fit the team leaf eval on self-play outcomes.
 *
 * Even seeds play max-damage and sometimes Terastallize. Odd seeds play a
 * random legal choice, so status, hazards, and Tera vary. The label is that
 * side's eventual result. Seeds split 60% train / 20% dev / 20% held-out
 * before any weight is updated. Held-out is scored once, after the train
 * fit is frozen.
 * TEAM_EVAL_DEV_ONLY=1 skips held-out.
 *
 *   npx tsx src/engine/exact/fit-team-eval.ts
 */
import fs from 'fs';
import path from 'path';
import { PRNG } from '@pkmn/sim';
import { legalChoices, safeChoose, startRandomBattle, teamsForSeed, type SideId } from './battle-utils.js';
import { maxDamageChoice } from './max-damage.js';
import { fitLogistic, scoreLogistic, type LabeledExample, type LogisticScore } from './logistic.js';
import {
  applyStandard,
  assertRandbatsSpecies,
  TEAM_EVAL_FEATURES,
  teamFeatureVector,
} from './team-features.js';

/** (lambda/2) * weight^2 on the averaged log loss. Fixed before held-out. */
const LAMBDA = 0.05;
const EPOCHS = 4000;
const GAMES = 200;
const PER_SIDE = 10;

export function splitForSeed(seed: number): 'train' | 'dev' | 'heldout' {
  const bucket = Math.abs(seed) % 5;
  if (bucket === 0) return 'heldout';
  if (bucket === 1) return 'dev';
  return 'train';
}

interface RawExample {
  features: number[];
  label: number;
  seed: number;
}

function columnStats(rows: number[][]): { mean: number[]; std: number[] } {
  const width = rows[0]?.length ?? 0;
  const mean = new Array(width).fill(0);
  const n = rows.length || 1;
  for (const row of rows) {
    for (let i = 0; i < width; i++) mean[i] += row[i] || 0;
  }
  for (let i = 0; i < width; i++) mean[i] /= n;
  const variance = new Array(width).fill(0);
  for (const row of rows) {
    for (let i = 0; i < width; i++) {
      const delta = (row[i] || 0) - mean[i];
      variance[i] += delta * delta;
    }
  }
  const std = variance.map(value => Math.sqrt(value / n));
  mean[0] = 0;
  std[0] = 1;
  return { mean, std };
}

function scale(examples: RawExample[], mean: number[], std: number[]): LabeledExample[] {
  return examples.map(example => ({
    label: example.label,
    features: applyStandard(example.features, mean, std),
  }));
}

function hpOnly(examples: LabeledExample[]): LabeledExample[] {
  return examples.map(example => ({
    label: example.label,
    features: [1, example.features[1] || 0, example.features[2] || 0],
  }));
}

function takeEven<T>(rows: T[], count: number): T[] {
  if (rows.length <= count) return rows;
  const picked: T[] = [];
  for (let i = 0; i < count; i++) {
    const index = Math.round((i * (rows.length - 1)) / (count - 1));
    picked.push(rows[index]);
  }
  return picked;
}

function playChoice(battle: ReturnType<typeof startRandomBattle>, side: SideId, seed: number, rng: PRNG): void {
  const legal = legalChoices(battle, side);
  if (legal.length === 0) return;
  const randomGame = seed % 2 === 1;
  const choice = randomGame ? legal[rng.random(legal.length)] ?? legal[0] : maxDamageChoice(battle, side, legal);
  if (!randomGame && choice.startsWith('move ')) {
    const mon = battle.getSide(side).active[0] as { canTerastallize?: unknown } | undefined;
    if (mon?.canTerastallize && (seed + battle.turn + (side === 'p2' ? 1 : 0)) % 5 === 0) {
      try {
        if (battle.choose(side, `${choice} terastallize`)) return;
      } catch {
        // The sim rejected Tera; play the plain move.
      }
      try {
        battle.getSide(side).clearChoice();
      } catch {
        // already clear
      }
    }
  }
  safeChoose(battle, side, choice);
}

function playGame(seed: number): RawExample[] {
  const teams = teamsForSeed(seed);
  const battle = startRandomBattle(teams.p1, teams.p2, seed);
  const rng = new PRNG([seed >>> 0, 0x9e3779b9, 0x12345678, 0xdecafbad] as never);
  const seen: Record<SideId, Array<{ features: number[]; side: SideId }>> = { p1: [], p2: [] };
  let loops = 0;
  while (!battle.ended && loops < 500) {
    loops++;
    const p1Legal = legalChoices(battle, 'p1');
    const p2Legal = legalChoices(battle, 'p2');
    if (p1Legal.length === 0 && p2Legal.length === 0) break;
    const preview = p1Legal.length === 1 && p1Legal[0] === 'default';
    if (!preview && battle.turn >= 1) {
      for (const side of ['p1', 'p2'] as const) {
        const legal = side === 'p1' ? p1Legal : p2Legal;
        if (legal.length === 0) continue;
        const features = teamFeatureVector(battle, side);
        if (features.some(value => !Number.isFinite(value))) continue;
        seen[side].push({ features, side });
      }
    }
    if (p1Legal.length) playChoice(battle, 'p1', seed, rng);
    if (!battle.ended && p2Legal.length) playChoice(battle, 'p2', seed, rng);
  }
  if (battle.winner !== 'P1' && battle.winner !== 'P2') return [];
  const winner = battle.winner === 'P1' ? 'p1' : 'p2';
  const kept = [...takeEven(seen.p1, PER_SIDE), ...takeEven(seen.p2, PER_SIDE)];
  return kept.map(row => ({
    features: row.features,
    label: row.side === winner ? 1 : 0,
    seed,
  }));
}

function formatScore(name: string, score: LogisticScore): string {
  return [
    `${name} n=${score.n} win-rate ${(score.rate * 100).toFixed(1)}%`,
    `logloss ${score.logLoss.toFixed(4)} constant ${score.constantLogLoss.toFixed(4)}`,
    `accuracy ${(score.accuracy * 100).toFixed(1)}%`,
  ].join(' | ');
}

function main(): void {
  const species = assertRandbatsSpecies();
  console.log(`randbats species ${species}`);
  const buckets: Record<'train' | 'dev' | 'heldout', RawExample[]> = { train: [], dev: [], heldout: [] };
  for (let seed = 1; seed <= GAMES; seed++) {
    const split = splitForSeed(seed);
    buckets[split].push(...playGame(seed));
    if (seed % 20 === 0) {
      console.log(
        `games ${seed}/${GAMES} train=${buckets.train.length} dev=${buckets.dev.length} heldout=${buckets.heldout.length}`,
      );
    }
  }
  if (buckets.train.length < 50) throw new Error(`train set too small (${buckets.train.length})`);
  const { mean, std } = columnStats(buckets.train.map(row => row.features));
  const train = scale(buckets.train, mean, std);
  const dev = scale(buckets.dev, mean, std);
  const fitted = fitLogistic(train, LAMBDA, EPOCHS);
  const hp = fitLogistic(hpOnly(train), LAMBDA, EPOCHS);
  const devTeam = scoreLogistic(dev, fitted.weights);
  const devHp = scoreLogistic(hpOnly(dev), hp.weights);
  console.log(formatScore('dev team', devTeam));
  console.log(formatScore('dev hp-only', devHp));
  console.log(`weights ${fitted.weights.map(value => value.toFixed(3)).join(' ')}`);
  console.log(`epochs ${fitted.epochsUsed}`);

  const model = {
    features: [...TEAM_EVAL_FEATURES],
    weights: fitted.weights,
    mean,
    std,
    lambda: LAMBDA,
    epochs: fitted.epochsUsed,
    optimizer: 'backtracking',
    penalty: 'lambda/2 w^2 on the averaged log loss, bias unpenalized',
    standardize: 'train mean and std, bias left as 1',
  };
  const modelPath = path.join(process.cwd(), 'src', 'engine', 'exact', 'eval-weights.json');
  fs.writeFileSync(modelPath, JSON.stringify(model, null, 2) + '\n');
  console.log(`wrote ${modelPath}`);

  if (process.env.TEAM_EVAL_DEV_ONLY === '1') {
    console.log('dev-only: held-out was not scored');
    return;
  }

  const held = scale(buckets.heldout, mean, std);
  const heldTeam = scoreLogistic(held, fitted.weights);
  const heldHp = scoreLogistic(hpOnly(held), hp.weights);
  console.log(formatScore('heldout team', heldTeam));
  console.log(formatScore('heldout hp-only', heldHp));

  const report = {
    species,
    games: GAMES,
    perSide: PER_SIDE,
    lambda: LAMBDA,
    epochs: fitted.epochsUsed,
    features: [...TEAM_EVAL_FEATURES],
    weights: fitted.weights,
    mean,
    std,
    counts: {
      train: buckets.train.length,
      dev: buckets.dev.length,
      heldout: buckets.heldout.length,
    },
    dev: { team: devTeam, hpOnly: devHp },
    heldout: { team: heldTeam, hpOnly: heldHp },
  };
  const reportDir = path.join(process.cwd(), 'state', 'models');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'team-eval-fit.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`wrote ${reportPath}`);
}

if (process.argv[1]?.includes('fit-team-eval')) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
