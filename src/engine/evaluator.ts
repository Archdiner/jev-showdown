import { GameState, EvaluationResult, PokemonBelief } from '../types/index.js';

/**
 * 0 HP is a faint, not a missing value. Only an unknown HP (no number at
 * all) is treated as a full bar.
 */
function hpFraction(mon: PokemonBelief): number {
  if (!mon.maxHp || mon.maxHp <= 0) return 0;
  if (mon.currentHp == null) return 1;
  return Math.max(0, mon.currentHp) / mon.maxHp;
}

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
    let myValue = 0;
    let oppValue = 0;

    for (const mon of state.myTeam) {
      if (mon.species === 'Unknown') continue;
      myValue += hpFraction(mon);
    }

    for (const mon of state.opponentTeam) {
      if (mon.species === 'Unknown') continue;
      oppValue += hpFraction(mon);
    }

    return (myValue - oppValue) * 2;
  }

  private evaluatePosition(state: GameState): number {
    let score = 0;

    if (state.hazards.opponent.stealthRock) score += this.weights.hazards;
    score += state.hazards.opponent.spikes * this.weights.hazards * 0.5;
    score += state.hazards.opponent.toxicSpikes * this.weights.hazards * 0.3;

    if (state.hazards.my.stealthRock) score -= this.weights.hazards;
    score -= state.hazards.my.spikes * this.weights.hazards * 0.5;
    score -= state.hazards.my.toxicSpikes * this.weights.hazards * 0.3;
    
    // Type matchup bonus
    const myActive = state.myTeam[state.myActive];
    const oppActive = state.opponentTeam[state.opponentActive];
    
    if (myActive && oppActive && oppActive.species !== 'Unknown') {
      // Estimate offensive pressure
      const myMoves = Array.from(myActive.revealedMoves || []);
      let bestEffectiveness = 0;
      
      for (const move of myMoves) {
        const eff = this.estimateEffectiveness(move, oppActive.species);
        bestEffectiveness = Math.max(bestEffectiveness, eff);
      }
      
      if (bestEffectiveness > 1.5) {
        score += 30; // We have super effective coverage
      } else if (bestEffectiveness < 0.75) {
        score -= 20; // Our moves are resisted
      }
    }

    return score;
  }
  
  private estimateEffectiveness(move: string, targetSpecies: string): number {
    // Simplified effectiveness estimation
    // In production, would use Dex.types
    return 1.0;
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
