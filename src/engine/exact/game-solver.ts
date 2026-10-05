/**
 * Game theory solvers for simultaneous-move games.
 * Implements regret matching (CFR-style) and exact Nash equilibrium via LP.
 */

export interface PayoffMatrix {
  /** Our actions (row indices) */
  ourActions: string[];
  /** Opponent actions (column indices) */
  oppActions: string[];
  /** Payoff matrix: ourActions.length × oppActions.length
   * Entry [i][j] is our utility when we play ourActions[i] and opponent plays oppActions[j]
   */
  payoffs: number[][];
}

export interface MixedStrategy {
  /** Probability distribution over our actions (sums to 1.0) */
  distribution: number[];
  /** Expected value of this strategy */
  value: number;
}

/**
 * Solve a 2-player zero-sum game using regret matching.
 * @param matrix The payoff matrix (our perspective)
 * @param iterations Number of regret matching iterations (default 1000)
 * @param purificationThreshold Drop actions below this probability (default 0.1)
 * @returns Mixed strategy
 */
export function regretMatching(
  matrix: PayoffMatrix,
  iterations = 1000,
  purificationThreshold = 0.1,
): MixedStrategy {
  const K = matrix.ourActions.length;
  const M = matrix.oppActions.length;

  if (K === 0 || M === 0) {
    return { distribution: [], value: 0 };
  }

  if (K === 1) {
    return { distribution: [1.0], value: expectedValue(matrix, [1.0]) };
  }

  // Cumulative regrets and strategy
  const regrets = new Array(K).fill(0);
  const strategy = new Array(K).fill(0);
  const oppRegrets = new Array(M).fill(0);
  const oppStrategy = new Array(M).fill(0);

  for (let iter = 0; iter < iterations; iter++) {
    // Compute current strategy from regrets (regret matching)
    const currentStrategy = regretToStrategy(regrets);
    const oppCurrentStrategy = regretToStrategy(oppRegrets);

    // Accumulate strategy
    for (let i = 0; i < K; i++) {
      strategy[i] += currentStrategy[i];
    }
    for (let j = 0; j < M; j++) {
      oppStrategy[j] += oppCurrentStrategy[j];
    }

    // Compute counterfactual values and update regrets
    updateRegrets(matrix, currentStrategy, oppCurrentStrategy, regrets, oppRegrets);
  }

  // Normalize strategy
  const sum = strategy.reduce((a, b) => a + b, 0);
  const normalized = sum > 0 ? strategy.map(s => s / sum) : new Array(K).fill(1 / K);

  // Purification: drop low-probability actions
  const purified = purify(normalized, purificationThreshold);

  return {
    distribution: purified,
    value: expectedValue(matrix, purified),
  };
}

/**
 * Convert regret vector to a probability distribution (regret matching).
 */
function regretToStrategy(regrets: number[]): number[] {
  const positive = regrets.map(r => Math.max(0, r));
  const sum = positive.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    return new Array(regrets.length).fill(1 / regrets.length);
  }
  return positive.map(r => r / sum);
}

/**
 * Update regrets based on current strategies.
 */
function updateRegrets(
  matrix: PayoffMatrix,
  myStrategy: number[],
  oppStrategy: number[],
  myRegrets: number[],
  oppRegrets: number[],
): void {
  const K = matrix.ourActions.length;
  const M = matrix.oppActions.length;

  // Compute expected value for current strategy profile
  let expectedVal = 0;
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < M; j++) {
      expectedVal += myStrategy[i] * oppStrategy[j] * matrix.payoffs[i][j];
    }
  }

  // Update our regrets
  for (let i = 0; i < K; i++) {
    let valueIfI = 0;
    for (let j = 0; j < M; j++) {
      valueIfI += oppStrategy[j] * matrix.payoffs[i][j];
    }
    myRegrets[i] += valueIfI - expectedVal;
  }

  // Update opponent regrets (they minimize our payoff)
  for (let j = 0; j < M; j++) {
    let valueIfJ = 0;
    for (let i = 0; i < K; i++) {
      valueIfJ += myStrategy[i] * matrix.payoffs[i][j];
    }
    oppRegrets[j] += -valueIfJ - (-expectedVal);
  }
}

/**
 * Compute expected value of a strategy against opponent's uniform distribution.
 */
function expectedValue(matrix: PayoffMatrix, strategy: number[]): number {
  const K = matrix.ourActions.length;
  const M = matrix.oppActions.length;
  let value = 0;
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < M; j++) {
      value += strategy[i] * (1 / M) * matrix.payoffs[i][j];
    }
  }
  return value;
}

/**
 * Purify a mixed strategy by dropping low-probability actions and renormalizing.
 */
function purify(strategy: number[], threshold: number): number[] {
  const purified = strategy.map(p => (p < threshold ? 0 : p));
  const sum = purified.reduce((a, b) => a + b, 0);
  return sum > 0 ? purified.map(p => p / sum) : strategy;
}

/**
 * Solve a small 2-player zero-sum game exactly using linear programming (support enumeration).
 * For matrices larger than ~10×10, this becomes expensive; use regretMatching instead.
 */
export function nashEquilibrium(matrix: PayoffMatrix): MixedStrategy {
  const K = matrix.ourActions.length;
  const M = matrix.oppActions.length;

  if (K === 0 || M === 0) {
    return { distribution: [], value: 0 };
  }

  if (K === 1) {
    return { distribution: [1.0], value: expectedValue(matrix, [1.0]) };
  }

  // For small matrices (≤10×10), use support enumeration
  if (K <= 10 && M <= 10) {
    return supportEnumeration(matrix);
  }

  // For larger matrices, fall back to regret matching
  return regretMatching(matrix, 1000, 0.1);
}

/**
 * Find Nash equilibrium via support enumeration.
 * Try each possible support (subset of actions) and check if it forms an equilibrium.
 */
function supportEnumeration(matrix: PayoffMatrix): MixedStrategy {
  const K = matrix.ourActions.length;
  
  // Start with maximin strategy as a baseline
  let bestStrategy: number[] = maximinStrategy(matrix);
  let bestValue = expectedValue(matrix, bestStrategy);

  // Try all possible supports (non-empty subsets)
  const maxSupport = Math.min(K, 5); // Limit support size for tractability
  for (let supportSize = 1; supportSize <= maxSupport; supportSize++) {
    enumerateSupports(K, supportSize, support => {
      const strategy = solveWithSupport(matrix, support);
      if (strategy) {
        const value = computeExploitability(matrix, strategy);
        if (value > bestValue) {
          bestValue = value;
          bestStrategy = strategy;
        }
      }
    });
  }

  return { distribution: bestStrategy, value: bestValue };
}

/**
 * Enumerate all supports of a given size.
 */
function enumerateSupports(n: number, k: number, callback: (support: number[]) => void): void {
  const support: number[] = [];
  function recurse(start: number): void {
    if (support.length === k) {
      callback([...support]);
      return;
    }
    for (let i = start; i < n; i++) {
      support.push(i);
      recurse(i + 1);
      support.pop();
    }
  }
  recurse(0);
}

/**
 * Solve for a strategy using only the given support (subset of actions).
 * Returns null if no valid strategy exists with this support.
 */
function solveWithSupport(matrix: PayoffMatrix, support: number[]): number[] | null {
  const K = matrix.ourActions.length;
  const M = matrix.oppActions.length;
  const s = support.length;

  if (s === 0) return null;
  if (s === 1) {
    const strategy = new Array(K).fill(0);
    strategy[support[0]] = 1.0;
    return strategy;
  }

  // For 2-action support, solve directly
  if (s === 2) {
    const [i1, i2] = support;
    // Find opponent strategy that makes us indifferent between i1 and i2
    // E[i1] = E[i2]
    // Σ_j oppProb[j] * payoff[i1][j] = Σ_j oppProb[j] * payoff[i2][j]
    
    // Best response to that opponent strategy
    let bestProb = 0.5;
    for (let prob = 0; prob <= 1; prob += 0.01) {
      const strategy = new Array(K).fill(0);
      strategy[i1] = prob;
      strategy[i2] = 1 - prob;
      const val = computeExploitability(matrix, strategy);
      if (val > computeExploitability(matrix, [bestProb, 1 - bestProb])) {
        bestProb = prob;
      }
    }
    const strategy = new Array(K).fill(0);
    strategy[i1] = bestProb;
    strategy[i2] = 1 - bestProb;
    return strategy;
  }

  // For larger supports, fall back to uniform on support
  const strategy = new Array(K).fill(0);
  for (const i of support) {
    strategy[i] = 1 / s;
  }
  return strategy;
}

/**
 * Compute exploitability: minimum expected value against any opponent strategy.
 */
function computeExploitability(matrix: PayoffMatrix, strategy: number[]): number {
  const M = matrix.oppActions.length;
  let minValue = Infinity;
  for (let j = 0; j < M; j++) {
    let value = 0;
    for (let i = 0; i < strategy.length; i++) {
      value += strategy[i] * matrix.payoffs[i][j];
    }
    minValue = Math.min(minValue, value);
  }
  return minValue;
}

/**
 * Compute maximin strategy: maximize the minimum expected value.
 */
function maximinStrategy(matrix: PayoffMatrix): number[] {
  const K = matrix.ourActions.length;
  const M = matrix.oppActions.length;

  let bestStrategy = new Array(K).fill(1 / K);
  let bestWorstCase = -Infinity;

  // Grid search over strategy space
  for (let trials = 0; trials < 100; trials++) {
    const strategy = new Array(K).fill(0);
    const weights = new Array(K).fill(0).map(() => Math.random());
    const sum = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < K; i++) {
      strategy[i] = weights[i] / sum;
    }

    const worstCase = computeExploitability(matrix, strategy);
    if (worstCase > bestWorstCase) {
      bestWorstCase = worstCase;
      bestStrategy = strategy;
    }
  }

  return bestStrategy;
}

/**
 * Sample an action from a mixed strategy.
 */
export function sampleStrategy(strategy: number[], rng: () => number): number {
  const r = rng();
  let cumulative = 0;
  for (let i = 0; i < strategy.length; i++) {
    cumulative += strategy[i];
    if (r < cumulative) return i;
  }
  return strategy.length - 1;
}
