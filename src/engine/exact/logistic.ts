/**
 * L2 logistic regression. Bias is unpenalized. Lambda is the penalty on the
 * averaged log loss, (lambda/2) * w^2, so it does not vanish as the sample
 * grows. Feature lists and lambda are fixed before held-out is scored.
 */

export interface LabeledExample {
  features: number[];
  label: number;
}

export interface LogisticScore {
  n: number;
  rate: number;
  logLoss: number;
  constantLogLoss: number;
  accuracy: number;
}

export function sigmoid(logit: number): number {
  if (logit > 30) return 1;
  if (logit < -30) return 0;
  return 1 / (1 + Math.exp(-logit));
}

export function dot(weights: number[], features: number[]): number {
  let total = 0;
  for (let i = 0; i < weights.length; i++) total += weights[i] * (features[i] || 0);
  return total;
}

function objective(examples: LabeledExample[], weights: number[], lambda: number): number {
  const n = examples.length || 1;
  let loss = 0;
  for (const example of examples) {
    const p = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(dot(weights, example.features))));
    const y = example.label;
    loss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }
  loss /= n;
  for (let i = 1; i < weights.length; i++) loss += (lambda / 2) * weights[i] * weights[i];
  return loss;
}

/** Backtracking gradient descent. Returns the weights and the epochs used. */
export function fitLogistic(
  examples: LabeledExample[],
  lambda = 1,
  epochs = 4000,
): { weights: number[]; epochsUsed: number } {
  const width = examples[0]?.features.length ?? 0;
  const weights = new Array(width).fill(0);
  const n = examples.length || 1;
  let previous = Infinity;
  let used = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    used = epoch + 1;
    const current = objective(examples, weights, lambda);
    if (previous - current < 1e-8) break;
    previous = current;
    const grad = new Array(weights.length).fill(0);
    for (const example of examples) {
      const error = sigmoid(dot(weights, example.features)) - example.label;
      for (let i = 0; i < weights.length; i++) grad[i] += error * (example.features[i] || 0);
    }
    const direction = grad.map((value, i) => value / n + (i === 0 ? 0 : lambda * weights[i]));
    const start = weights.slice();
    let step = 1;
    let accepted = false;
    for (let attempt = 0; attempt < 24; attempt++) {
      for (let i = 0; i < weights.length; i++) weights[i] = start[i] - step * direction[i];
      if (objective(examples, weights, lambda) <= current) {
        accepted = true;
        break;
      }
      step /= 2;
    }
    if (!accepted) {
      for (let i = 0; i < weights.length; i++) weights[i] = start[i];
      break;
    }
  }
  return { weights, epochsUsed: used };
}

export function scoreLogistic(examples: LabeledExample[], weights: number[]): LogisticScore {
  let loss = 0;
  let correct = 0;
  let positives = 0;
  for (const example of examples) {
    const p = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(dot(weights, example.features))));
    const y = example.label;
    loss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    if ((p >= 0.5 ? 1 : 0) === y) correct++;
    positives += y;
  }
  const n = examples.length || 1;
  const rate = positives / n;
  const constantP = Math.min(1 - 1e-12, Math.max(1e-12, rate));
  const constantLogLoss = -(rate * Math.log(constantP) + (1 - rate) * Math.log(1 - constantP));
  return {
    n: examples.length,
    rate,
    logLoss: loss / n,
    constantLogLoss,
    accuracy: correct / n,
  };
}
