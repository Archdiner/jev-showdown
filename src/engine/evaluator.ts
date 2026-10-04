import { GameState, EvaluationResult, PokemonBelief } from '../types/index.js';

export interface EvaluatorWeights {
  material: number;
  hp: number;
  position: number;
  hazards: number;
  momentum: number;
  information: number;
}

export class Evaluator {
  private weights: EvaluatorWeights = {
    material: 100,
    hp: 50,
    position: 30,
    hazards: 20,
    momentum: 15,
    information: 10,
  };

  constructor(weights?: Partial<EvaluatorWeights>) {
    if (weights) {
      this.weights = { ...this.weights, ...weights };
    }
  }

  evaluate(state: GameState): EvaluationResult {
    const material = this.evaluateMaterial(state);
    const position = this.evaluatePosition(state);
    const momentum = this.evaluateMomentum(state);
    const heuristics = this.evaluateHeuristics(state);

    const score =
      material * this.weights.material +
      position * this.weights.position +
      momentum * this.weights.momentum +
      heuristics;

    return {
      score,
      breakdown: {
        material,
        position,
        momentum,
        heuristics,
      },
    };
  }

  private evaluateMaterial(state: GameState): number {
    const myAlive = state.myTeam.filter(m => m.species !== 'Unknown').length;
    const oppAlive = state.opponentTeam.filter(m => m.species !== 'Unknown').length;
    
    return (myAlive - oppAlive) * 2;
  }

  private evaluatePosition(state: GameState): number {
    let score = 0;

    if (state.hazards.opponent.stealthRock) score += this.weights.hazards;
    score += state.hazards.opponent.spikes * this.weights.hazards * 0.5;
    score += state.hazards.opponent.toxicSpikes * this.weights.hazards * 0.3;

    if (state.hazards.my.stealthRock) score -= this.weights.hazards;
    score -= state.hazards.my.spikes * this.weights.hazards * 0.5;
    score -= state.hazards.my.toxicSpikes * this.weights.hazards * 0.3;

    return score;
  }

  private evaluateMomentum(state: GameState): number {
    let score = 0;

    if (state.field.weather) {
      score += 5;
    }

    if (state.field.terrain) {
      score += 5;
    }

    if (state.field.screens.reflect) {
      score += 10;
    }

    if (state.field.screens.lightScreen) {
      score += 10;
    }

    return score;
  }

  private evaluateHeuristics(state: GameState): number {
    let score = 0;

    const myRevealed = state.myTeam.filter(m => m.revealedMoves.size > 0).length;
    const oppRevealed = state.opponentTeam.filter(m => m.revealedMoves.size > 0).length;
    
    score += (oppRevealed - myRevealed) * this.weights.information;

    if (!state.myTeraUsed && state.opponentTeraUsed) {
      score += 20;
    } else if (state.myTeraUsed && !state.opponentTeraUsed) {
      score -= 20;
    }

    return score;
  }

  updateWeights(newWeights: Partial<EvaluatorWeights>): void {
    this.weights = { ...this.weights, ...newWeights };
  }

  getWeights(): EvaluatorWeights {
    return { ...this.weights };
  }
}
