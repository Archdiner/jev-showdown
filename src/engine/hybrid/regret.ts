/**
 * Regret matching on a one-shot matrix game.
 * Rows are our actions (we maximize). Columns are opponent replies (they minimize).
 * The average column strategy is the mixed reply model.
 */

export interface RegretResult {
  rowMix: number[];
  colMix: number[];
  /** Expected value of each row against the opponent's average strategy. */
  rowValues: number[];
}

export function regretMatch(payoff: number[][], iterations = 24): RegretResult {
  const rows = payoff.length;
  const cols = payoff[0]?.length ?? 0;
  if (rows === 0 || cols === 0) return { rowMix: [], colMix: [], rowValues: [] };

  const rowRegret = Array(rows).fill(0);
  const colRegret = Array(cols).fill(0);
  const rowSum = Array(rows).fill(0);
  const colSum = Array(cols).fill(0);

  for (let t = 0; t < iterations; t++) {
    const rowStrat = positiveStrategy(rowRegret);
    const colStrat = positiveStrategy(colRegret);
    const rowEv = payoff.map(line => dot(line, colStrat));
    const value = dot(rowEv, rowStrat);
    for (let i = 0; i < rows; i++) rowRegret[i] += rowEv[i] - value;

    const colEv = Array.from({ length: cols }, (_, j) => {
      let sum = 0;
      for (let i = 0; i < rows; i++) sum += rowStrat[i] * payoff[i][j];
      return sum;
    });
    const colValue = dot(colEv, colStrat);
    for (let j = 0; j < cols; j++) colRegret[j] += colValue - colEv[j];

    for (let i = 0; i < rows; i++) rowSum[i] += rowStrat[i];
    for (let j = 0; j < cols; j++) colSum[j] += colStrat[j];
  }

  const colMix = normalize(colSum);
  const rowValues = payoff.map(line => dot(line, colMix));
  return { rowMix: normalize(rowSum), colMix, rowValues };
}

function positiveStrategy(regret: number[]): number[] {
  const pos = regret.map(value => Math.max(0, value));
  const sum = pos.reduce((total, value) => total + value, 0);
  if (sum <= 0) return regret.map(() => 1 / regret.length);
  return pos.map(value => value / sum);
}

function normalize(weights: number[]): number[] {
  const sum = weights.reduce((total, value) => total + value, 0);
  if (sum <= 0) return weights.map(() => 1 / weights.length);
  return weights.map(value => value / sum);
}

function dot(left: number[], right: number[]): number {
  let sum = 0;
  for (let i = 0; i < left.length; i++) sum += left[i] * (right[i] ?? 0);
  return sum;
}
