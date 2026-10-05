#!/usr/bin/env python3
"""
Train a neural network value function for Pokemon battle evaluation.
Simple MLP with ReLU activations and a skip connection.
"""

import json
import numpy as np
import sys
from pathlib import Path
from typing import Dict, List, Tuple
from datetime import datetime

# Use NumPy for simplicity - no heavy dependencies needed for this size
class MLP:
    def __init__(self, input_dim: int, hidden1: int, hidden2: int):
        self.input_dim = input_dim
        self.hidden1 = hidden1
        self.hidden2 = hidden2
        
        # Xavier initialization
        self.w1 = np.random.randn(hidden1, input_dim) * np.sqrt(2.0 / input_dim)
        self.b1 = np.zeros(hidden1)
        
        self.w2 = np.random.randn(hidden2, hidden1) * np.sqrt(2.0 / hidden1)
        self.b2 = np.zeros(hidden2)
        
        self.w3 = np.random.randn(1, hidden2) * np.sqrt(2.0 / hidden2)
        self.b3 = np.zeros(1)
        
        # Skip connection from first 10 features (team eval features)
        skip_dim = min(10, input_dim)
        self.w_skip = np.random.randn(1, skip_dim) * np.sqrt(2.0 / skip_dim)
        self.b_skip = np.zeros(1)
    
    def forward(self, x: np.ndarray) -> Tuple[np.ndarray, Dict]:
        """Forward pass with intermediate activations for backprop."""
        # Layer 1
        z1 = x @ self.w1.T + self.b1
        h1 = np.maximum(0, z1)  # ReLU
        
        # Layer 2
        z2 = h1 @ self.w2.T + self.b2
        h2 = np.maximum(0, z2)  # ReLU
        
        # Output
        z3 = h2 @ self.w3.T + self.b3
        
        # Skip connection
        skip_dim = self.w_skip.shape[1]
        skip = x[:, :skip_dim] @ self.w_skip.T + self.b_skip
        
        # Combine
        out = z3 + skip
        
        # Tanh activation
        y = np.tanh(out)
        
        cache = {
            'x': x, 'z1': z1, 'h1': h1, 'z2': z2, 'h2': h2,
            'z3': z3, 'skip': skip, 'out': out, 'y': y
        }
        return y, cache
    
    def backward(self, cache: Dict, targets: np.ndarray, learning_rate: float):
        """Backprop with MSE loss."""
        batch_size = cache['x'].shape[0]
        
        # Loss: MSE on tanh output vs target in [0, 1]
        # We'll train on targets in [0, 1] representing win probability
        dy = (cache['y'] - targets) / batch_size
        
        # Derivative of tanh
        dout = dy * (1 - cache['y'] ** 2)
        
        # Gradient through skip connection
        skip_dim = self.w_skip.shape[1]
        dw_skip = dout.T @ cache['x'][:, :skip_dim]
        db_skip = dout.sum(axis=0)
        
        # Gradient through main path
        dz3 = dout
        dw3 = dz3.T @ cache['h2']
        db3 = dz3.sum(axis=0)
        dh2 = dz3 @ self.w3
        
        # ReLU gradient
        dz2 = dh2 * (cache['z2'] > 0)
        dw2 = dz2.T @ cache['h1']
        db2 = dz2.sum(axis=0)
        dh1 = dz2 @ self.w2
        
        # ReLU gradient
        dz1 = dh1 * (cache['z1'] > 0)
        dw1 = dz1.T @ cache['x']
        db1 = dz1.sum(axis=0)
        
        # Update weights
        self.w1 -= learning_rate * dw1
        self.b1 -= learning_rate * db1
        self.w2 -= learning_rate * dw2
        self.b2 -= learning_rate * db2
        self.w3 -= learning_rate * dw3
        self.b3 -= learning_rate * db3
        self.w_skip -= learning_rate * dw_skip
        self.b_skip -= learning_rate * db_skip
    
    def to_json(self) -> dict:
        """Export weights to JSON format for TypeScript inference."""
        return {
            'inputDim': int(self.input_dim),
            'hidden1': int(self.hidden1),
            'hidden2': int(self.hidden2),
            'w1': self.w1.flatten().tolist(),
            'b1': self.b1.tolist(),
            'w2': self.w2.flatten().tolist(),
            'b2': self.b2.tolist(),
            'w3': self.w3.flatten().tolist(),
            'b3': self.b3.tolist(),
            'wSkip': self.w_skip.flatten().tolist(),
            'bSkip': self.b_skip.tolist(),
        }


def load_data(jsonl_path: str) -> Tuple[np.ndarray, np.ndarray, List[dict]]:
    """Load training data from JSONL."""
    features_list = []
    outcomes = []
    metas = []
    
    with open(jsonl_path, 'r') as f:
        for line in f:
            sample = json.loads(line)
            features_list.append(sample['features'])
            outcomes.append(sample['outcome'])
            metas.append(sample['meta'])
    
    X = np.array(features_list, dtype=np.float32)
    y = np.array(outcomes, dtype=np.float32).reshape(-1, 1)
    
    return X, y, metas


def split_by_seed(data_path: str, train_ratio: float = 0.7, dev_ratio: float = 0.1):
    """Split data by seed into train/dev/test."""
    # Load all samples
    samples = []
    with open(data_path, 'r') as f:
        for line in f:
            samples.append(json.loads(line))
    
    # Group by seed
    by_seed = {}
    for sample in samples:
        seed = sample['seed']
        if seed not in by_seed:
            by_seed[seed] = []
        by_seed[seed].append(sample)
    
    # Split seeds
    seeds = sorted(by_seed.keys())
    n_seeds = len(seeds)
    n_train = int(n_seeds * train_ratio)
    n_dev = int(n_seeds * dev_ratio)
    
    train_seeds = seeds[:n_train]
    dev_seeds = seeds[n_train:n_train+n_dev]
    test_seeds = seeds[n_train+n_dev:]
    
    # Collect samples for each split
    train_samples = [s for seed in train_seeds for s in by_seed[seed]]
    dev_samples = [s for seed in dev_seeds for s in by_seed[seed]]
    test_samples = [s for seed in test_seeds for s in by_seed[seed]]
    
    print(f"Split: {len(train_seeds)} train seeds ({len(train_samples)} pos), "
          f"{len(dev_seeds)} dev seeds ({len(dev_samples)} pos), "
          f"{len(test_seeds)} test seeds ({len(test_samples)} pos)")
    
    return train_samples, dev_samples, test_samples


def brier_score(predictions: np.ndarray, targets: np.ndarray) -> float:
    """Calculate Brier score (lower is better)."""
    return np.mean((predictions - targets) ** 2)


def train(data_path: str, output_path: str, hidden1: int = 256, hidden2: int = 64,
          epochs: int = 20, batch_size: int = 256, learning_rate: float = 0.001):
    """Train the neural network."""
    
    print(f"Loading data from {data_path}...")
    train_samples, dev_samples, test_samples = split_by_seed(data_path)
    
    # Convert to arrays
    X_train = np.array([s['features'] for s in train_samples], dtype=np.float32)
    y_train = np.array([s['outcome'] for s in train_samples], dtype=np.float32).reshape(-1, 1)
    
    X_dev = np.array([s['features'] for s in dev_samples], dtype=np.float32)
    y_dev = np.array([s['outcome'] for s in dev_samples], dtype=np.float32).reshape(-1, 1)
    
    X_test = np.array([s['features'] for s in test_samples], dtype=np.float32)
    y_test = np.array([s['outcome'] for s in test_samples], dtype=np.float32).reshape(-1, 1)
    
    input_dim = X_train.shape[1]
    print(f"Input dimension: {input_dim}")
    print(f"Architecture: {input_dim} -> {hidden1} -> {hidden2} -> 1")
    
    # Initialize model
    model = MLP(input_dim, hidden1, hidden2)
    
    # Count parameters
    n_params = (input_dim * hidden1 + hidden1 +
                hidden1 * hidden2 + hidden2 +
                hidden2 * 1 + 1 +
                min(10, input_dim) * 1 + 1)
    print(f"Total parameters: {n_params:,}")
    
    # Training loop
    best_dev_brier = float('inf')
    best_weights = None
    
    print(f"\nTraining for {epochs} epochs...")
    for epoch in range(epochs):
        # Shuffle training data
        indices = np.random.permutation(len(X_train))
        X_train_shuffled = X_train[indices]
        y_train_shuffled = y_train[indices]
        
        # Mini-batch training
        for i in range(0, len(X_train), batch_size):
            X_batch = X_train_shuffled[i:i+batch_size]
            y_batch = y_train_shuffled[i:i+batch_size]
            
            # Forward and backward
            _, cache = model.forward(X_batch)
            model.backward(cache, y_batch, learning_rate)
        
        # Evaluate
        train_pred, _ = model.forward(X_train)
        dev_pred, _ = model.forward(X_dev)
        
        train_brier = brier_score(train_pred, y_train)
        dev_brier = brier_score(dev_pred, y_dev)
        
        print(f"Epoch {epoch+1}/{epochs}: train_brier={train_brier:.4f}, dev_brier={dev_brier:.4f}")
        
        # Save best model
        if dev_brier < best_dev_brier:
            best_dev_brier = dev_brier
            best_weights = model.to_json()
    
    # Final evaluation on test set
    print("\nFinal evaluation on test set:")
    test_pred, _ = model.forward(X_test)
    test_brier = brier_score(test_pred, y_test)
    print(f"Test Brier score: {test_brier:.4f}")
    
    # Save weights
    output_file = Path(output_path)
    output_file.parent.mkdir(parents=True, exist_ok=True)
    
    with open(output_file, 'w') as f:
        json.dump(best_weights, f)
    
    print(f"\nWeights saved to {output_file}")
    
    # Save training metadata
    meta_file = output_file.with_suffix('.meta.json')
    with open(meta_file, 'w') as f:
        json.dump({
            'trainedAt': datetime.now().isoformat(),
            'dataPath': data_path,
            'architecture': {
                'inputDim': input_dim,
                'hidden1': hidden1,
                'hidden2': hidden2,
            },
            'parameters': n_params,
            'epochs': epochs,
            'batchSize': batch_size,
            'learningRate': learning_rate,
            'bestDevBrier': float(best_dev_brier),
            'testBrier': float(test_brier),
            'trainSamples': len(train_samples),
            'devSamples': len(dev_samples),
            'testSamples': len(test_samples),
        }, f, indent=2)
    
    print(f"Metadata saved to {meta_file}")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python train.py <data.jsonl> [output.json] [hidden1] [hidden2]")
        sys.exit(1)
    
    data_path = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else 'data/neural/weights.json'
    hidden1 = int(sys.argv[3]) if len(sys.argv) > 3 else 256
    hidden2 = int(sys.argv[4]) if len(sys.argv) > 4 else 64
    
    train(data_path, output_path, hidden1, hidden2)
