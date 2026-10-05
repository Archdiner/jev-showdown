/**
 * Zero-sum matrix-game solve for one simultaneous turn (opt-in, see
 * ExactConfig.replySolve). Rows are our choices, columns foe replies, and
 * cells our value. Regret matching+ with averaged strategies converges to
 * a Nash equilibrium of the zero-sum game.
 */
export interface MatrixSolution {
  /** Our equilibrium mix over rows. */
  rows: number[];
  /** The foe's equilibrium mix over columns. */
  cols: number[];
  /** Our expected value under (rows, cols). */
  value: number;
}

export function solveZeroSum(payoffs: number[][], iterations = 400): MatrixSolution {
  const K = payoffs.length;
  const M = K > 0 ? payoffs[0].length : 0;
  if (K === 0 || M === 0) return { rows: [], cols: [], value: 0 };
  const rowRegret = new Array(K).fill(0);
  const colRegret = new Array(M).fill(0);
  const rowSum = new Array(K).fill(0);
  const colSum = new Array(M).fill(0);
  for (let t = 1; t <= iterations; t++) {
    const x = strategy(rowRegret);
    const y = strategy(colRegret);
    // Linear averaging (weight t) speeds up RM+ convergence.
    for (let i = 0; i < K; i++) rowSum[i] += t * x[i];
    for (let j = 0; j < M; j++) colSum[j] += t * y[j];
    const rowValues = payoffs.map(row => row.reduce((sum, v, j) => sum + v * y[j], 0));
    const colValues = new Array(M).fill(0);
    for (let i = 0; i < K; i++) for (let j = 0; j < M; j++) colValues[j] += x[i] * payoffs[i][j];
    const value = rowValues.reduce((sum, v, i) => sum + v * x[i], 0);
    for (let i = 0; i < K; i++) rowRegret[i] = Math.max(0, rowRegret[i] + rowValues[i] - value);
    // The foe minimises our value.
    for (let j = 0; j < M; j++) colRegret[j] = Math.max(0, colRegret[j] + value - colValues[j]);
  }
  const rows = normalize(rowSum);
  const cols = normalize(colSum);
  let value = 0;
  for (let i = 0; i < K; i++) for (let j = 0; j < M; j++) value += rows[i] * cols[j] * payoffs[i][j];
  return { rows, cols, value };
}

function strategy(regret: number[]): number[] {
  const total = regret.reduce((sum, r) => sum + r, 0);
  if (total <= 0) return regret.map(() => 1 / regret.length);
  return regret.map(r => r / total);
}

function normalize(values: number[]): number[] {
  const total = values.reduce((sum, v) => sum + v, 0);
  if (total <= 0) return values.map(() => 1 / values.length);
  return values.map(v => v / total);
}
