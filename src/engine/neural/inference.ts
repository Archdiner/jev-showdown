/**
 * Pure TypeScript neural network inference.
 * Simple MLP with ReLU activations and a tanh output.
 */

export interface MLPWeights {
  /** Input layer: [inputDim, hiddenDim1] */
  w1: Float32Array;
  b1: Float32Array;
  
  /** Hidden layer 2: [hiddenDim1, hiddenDim2] */
  w2: Float32Array;
  b2: Float32Array;
  
  /** Output layer: [hiddenDim2, 1] */
  w3: Float32Array;
  b3: Float32Array;
  
  /** Linear skip connection from first 10 features (team eval features) */
  wSkip: Float32Array;
  bSkip: Float32Array;
  
  /** Network architecture dimensions */
  inputDim: number;
  hidden1: number;
  hidden2: number;
}

/**
 * Forward pass through the MLP.
 * Returns a value in [-1, 1] via tanh activation.
 */
export function forwardPass(input: Float32Array, weights: MLPWeights): number {
  const { inputDim, hidden1, hidden2 } = weights;
  
  // Validate input size
  if (input.length !== inputDim) {
    throw new Error(`Input dimension mismatch: expected ${inputDim}, got ${input.length}`);
  }
  
  // Layer 1: input -> hidden1 with ReLU
  const h1 = new Float32Array(hidden1);
  for (let i = 0; i < hidden1; i++) {
    let sum = weights.b1[i];
    for (let j = 0; j < inputDim; j++) {
      sum += input[j] * weights.w1[i * inputDim + j];
    }
    h1[i] = Math.max(0, sum); // ReLU
  }
  
  // Layer 2: hidden1 -> hidden2 with ReLU
  const h2 = new Float32Array(hidden2);
  for (let i = 0; i < hidden2; i++) {
    let sum = weights.b2[i];
    for (let j = 0; j < hidden1; j++) {
      sum += h1[j] * weights.w2[i * hidden1 + j];
    }
    h2[i] = Math.max(0, sum); // ReLU
  }
  
  // Layer 3: hidden2 -> 1 (linear, no activation yet)
  let output = weights.b3[0];
  for (let i = 0; i < hidden2; i++) {
    output += h2[i] * weights.w3[i];
  }
  
  // Skip connection from first 10 features (team eval features)
  let skip = weights.bSkip[0];
  for (let i = 0; i < Math.min(10, inputDim); i++) {
    skip += input[i] * weights.wSkip[i];
  }
  
  // Combine main path and skip connection
  output += skip;
  
  // Apply tanh to get output in [-1, 1]
  return Math.tanh(output);
}

/**
 * Load weights from a JSON file.
 * Expected format matches what the Python training script exports.
 */
export function loadWeights(weightsJson: any): MLPWeights {
  // Validate structure
  if (!weightsJson.w1 || !weightsJson.b1 || !weightsJson.w2 || !weightsJson.b2 ||
      !weightsJson.w3 || !weightsJson.b3 || !weightsJson.wSkip || !weightsJson.bSkip) {
    throw new Error('Invalid weights JSON: missing required weight tensors');
  }
  
  if (!weightsJson.inputDim || !weightsJson.hidden1 || !weightsJson.hidden2) {
    throw new Error('Invalid weights JSON: missing architecture dimensions');
  }
  
  return {
    w1: new Float32Array(weightsJson.w1),
    b1: new Float32Array(weightsJson.b1),
    w2: new Float32Array(weightsJson.w2),
    b2: new Float32Array(weightsJson.b2),
    w3: new Float32Array(weightsJson.w3),
    b3: new Float32Array(weightsJson.b3),
    wSkip: new Float32Array(weightsJson.wSkip),
    bSkip: new Float32Array(weightsJson.bSkip),
    inputDim: weightsJson.inputDim,
    hidden1: weightsJson.hidden1,
    hidden2: weightsJson.hidden2,
  };
}

/**
 * Calculate the number of parameters in the network.
 */
export function countParameters(weights: MLPWeights): number {
  const { inputDim, hidden1, hidden2 } = weights;
  const w1Params = inputDim * hidden1;
  const w2Params = hidden1 * hidden2;
  const w3Params = hidden2 * 1;
  const skipParams = Math.min(10, inputDim) * 1;
  const biasParams = hidden1 + hidden2 + 1 + 1; // b1, b2, b3, bSkip
  return w1Params + w2Params + w3Params + skipParams + biasParams;
}
