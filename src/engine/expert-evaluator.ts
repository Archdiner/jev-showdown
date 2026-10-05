import { Dex } from '@pkmn/sim';
import { GameState, EvaluationResult, PokemonBelief } from '../types/index.js';
import { Evaluator, EvaluatorWeights } from './evaluator.js';

export interface ExpertFeatures {
  hazardDifferential?: boolean;
  protectHazardSetter?: boolean;
  resourcePreservation?: boolean;
  teraSecond?: boolean;
  speedOptionPreservation?: boolean;
  tempoSwitch?: boolean;
}

/**
 * Expert strategy evaluator implementing top-player insights.
 * Each feature can be toggled independently for A/B testing.
 */
export class ExpertEvaluator extends Evaluator {
  private features: ExpertFeatures;

  constructor(weights?: Partial<EvaluatorWeights>, features: ExpertFeatures = {}) {
    super(weights);
    this.features = features;
  }

  evaluate(state: GameState): EvaluationResult {
    // Start with base evaluation
    const baseResult = super.evaluate(state);
    let score = baseResult.score;

    // Apply expert features
    if (this.features.hazardDifferential) {
      score += this.evaluateHazardDifferential(state);
    }

    if (this.features.protectHazardSetter) {
      score += this.evaluateHazardSetterProtection(state);
    }

    if (this.features.resourcePreservation) {
      score += this.evaluateResourcePreservation(state);
    }

    if (this.features.teraSecond) {
      score += this.evaluateTeraSecond(state);
    }

    if (this.features.speedOptionPreservation) {
      score += this.evaluateSpeedOptionPreservation(state);
    }

    if (this.features.tempoSwitch) {
      score += this.evaluateTempoSwitch(state);
    }

    return {
      score,
      breakdown: baseResult.breakdown,
    };
  }

  /**
   * Hypothesis 1: Hazard differential weighted by boots/removal rarity.
   * Hazards are huge in randbats because Heavy-Duty Boots and removal are rare.
   */
  private evaluateHazardDifferential(state: GameState): number {
    let score = 0;

    // Count boots on each side (this weights hazard advantage)
    const myBootsCount = state.myTeam.filter(
      mon => mon.revealedItem?.toLowerCase().includes('heavydutyboots') || 
             mon.revealedItem?.toLowerCase().includes('heavy duty boots')
    ).length;

    const oppBootsCount = state.opponentTeam.filter(
      mon => mon.revealedItem?.toLowerCase().includes('heavydutyboots') ||
             mon.revealedItem?.toLowerCase().includes('heavy duty boots')
    ).length;

    // Count removal moves (Rapid Spin, Defog)
    const myRemoval = state.myTeam.filter(mon => 
      Array.from(mon.revealedMoves).some(m => 
        m.toLowerCase().includes('rapidspin') || 
        m.toLowerCase().includes('defog')
      )
    ).length;

    const oppRemoval = state.opponentTeam.filter(mon =>
      Array.from(mon.revealedMoves).some(m =>
        m.toLowerCase().includes('rapidspin') ||
        m.toLowerCase().includes('defog')
      )
    ).length;

    // Weight hazards more if opponent lacks boots/removal
    let hazardMultiplier = 1.0;

    if (oppBootsCount === 0 && oppRemoval === 0) {
      hazardMultiplier = 3.0; // Our hazards are extremely valuable
    } else if (oppBootsCount === 0 || oppRemoval === 0) {
      hazardMultiplier = 2.0; // Our hazards are very valuable
    }

    // Weight opponent hazards more if we lack boots/removal
    let oppHazardMultiplier = 1.0;
    if (myBootsCount === 0 && myRemoval === 0) {
      oppHazardMultiplier = 3.0; // Their hazards hurt a lot
    } else if (myBootsCount === 0 || myRemoval === 0) {
      oppHazardMultiplier = 2.0;
    }

    // Evaluate our hazards
    if (state.hazards.opponent.stealthRock) {
      score += 40 * hazardMultiplier;
    }
    score += state.hazards.opponent.spikes * 25 * hazardMultiplier;
    
    // Toxic Spikes are especially deadly if opponent has few Poison/Steel types
    if (state.hazards.opponent.toxicSpikes > 0) {
      const oppPoisonOrSteel = state.opponentTeam.filter(mon => {
        const species = Dex.species.get(mon.species);
        return species.exists && species.types.some(t => t === 'Poison' || t === 'Steel');
      }).length;

      const toxicValue = oppPoisonOrSteel <= 1 ? 50 : 30; // Huge if they can't switch into it
      score += state.hazards.opponent.toxicSpikes * toxicValue * hazardMultiplier;
    }

    // Evaluate opponent hazards
    if (state.hazards.my.stealthRock) {
      score -= 40 * oppHazardMultiplier;
    }
    score -= state.hazards.my.spikes * 25 * oppHazardMultiplier;

    if (state.hazards.my.toxicSpikes > 0) {
      const myPoisonOrSteel = state.myTeam.filter(mon => {
        const species = Dex.species.get(mon.species);
        return species.exists && species.types.some(t => t === 'Poison' || t === 'Steel');
      }).length;

      const toxicValue = myPoisonOrSteel <= 1 ? 50 : 30;
      score -= state.hazards.my.toxicSpikes * toxicValue * oppHazardMultiplier;
    }

    return score;
  }

  /**
   * Hypothesis 2: Protect hazard setter (never risk it).
   * Get the setter in safely and keep it alive.
   */
  private evaluateHazardSetterProtection(state: GameState): number {
    let score = 0;

    // Identify our hazard setters
    const mySetters = state.myTeam.filter(mon =>
      Array.from(mon.revealedMoves).some(m =>
        m.toLowerCase().includes('stealthrock') ||
        m.toLowerCase().includes('spikes') ||
        m.toLowerCase().includes('toxicspikes')
      )
    );

    if (mySetters.length === 0) return 0;

    // Check if any setter is at risk
    const mySetter = mySetters[0]; // Primary setter
    const myActive = state.myTeam[state.myActive];

    // If setter is active
    if (myActive.species === mySetter.species) {
      const hpPercent = mySetter.currentHp && mySetter.maxHp 
        ? mySetter.currentHp / mySetter.maxHp 
        : 1.0;

      // Penalize if setter is low HP and in danger
      if (hpPercent < 0.4) {
        score -= 300; // Very bad to have setter at risk
      } else if (hpPercent < 0.6) {
        score -= 150;
      }

      // Exception: sacrificing slow, low-HP setter for momentum is OK
      const setterSpeed = mySetter.stats?.spe || 85;
      if (hpPercent < 0.3 && setterSpeed < 70) {
        score += 150; // Negate penalty for slow, low-HP setter sac
      }
    } else {
      // Setter is benched - good
      const hpPercent = mySetter.currentHp && mySetter.maxHp
        ? mySetter.currentHp / mySetter.maxHp
        : 1.0;

      // Bonus if setter is healthy and preserved
      if (hpPercent > 0.8) {
        score += 100;
      }
    }

    return score;
  }

  /**
   * Hypothesis 3: Resource preservation (don't throw mons away to unknown threats).
   * No team preview means information is an advantage.
   */
  private evaluateResourcePreservation(state: GameState): number {
    let score = 0;

    // Count unknown opponent mons
    const unknownOpponents = state.opponentTeam.filter(
      mon => mon.species === 'Unknown' || mon.revealedMoves.size === 0
    ).length;

    // If we have many unknown opponents, penalize risky plays
    if (unknownOpponents >= 4) {
      // Check if our active mon is at risk
      const myActive = state.myTeam[state.myActive];
      const hpPercent = myActive.currentHp && myActive.maxHp
        ? myActive.currentHp / myActive.maxHp
        : 1.0;

      // Penalize staying in when we might die to unknown threat
      if (hpPercent < 0.5) {
        score -= 200 * (unknownOpponents / 6);
      }
    }

    // Bonus for revealing opponent team
    const revealedOpponents = state.opponentTeam.filter(
      mon => mon.species !== 'Unknown' && mon.revealedMoves.size > 0
    ).length;

    score += revealedOpponents * 50; // Info advantage

    // Penalty for having our mons revealed
    const revealedMy = state.myTeam.filter(
      mon => mon.revealedMoves.size > 0
    ).length;

    score -= revealedMy * 25; // Opponent knows more about us

    return score;
  }

  /**
   * Hypothesis 4: Tera-second prior (opponent Teras first).
   * Using Tera second preserves our options.
   */
  private evaluateTeraSecond(state: GameState): number {
    if (!state.myTeraUsed && !state.opponentTeraUsed) {
      // Neither has Tera'd - penalize our Tera
      return -150;
    }

    if (state.opponentTeraUsed && !state.myTeraUsed) {
      // Opponent Tera'd first - we're in a good spot
      return 100;
    }

    if (state.myTeraUsed && !state.opponentTeraUsed) {
      // We Tera'd first - mild penalty (already committed)
      return -50;
    }

    return 0;
  }

  /**
   * Hypothesis 5: Speed option preservation.
   * Identify and preserve fastest mon / priority / Scarf for endgame.
   */
  private evaluateSpeedOptionPreservation(state: GameState): number {
    let score = 0;

    // Find our speed option
    let fastestSpeed = 0;
    let speedOptionIndex = -1;

    for (let i = 0; i < state.myTeam.length; i++) {
      const mon = state.myTeam[i];
      if (mon.species === 'Unknown') continue;

      // Check for priority moves
      const hasPriority = Array.from(mon.revealedMoves).some(m =>
        m.toLowerCase().includes('extremespeed') ||
        m.toLowerCase().includes('aquajet') ||
        m.toLowerCase().includes('machpunch') ||
        m.toLowerCase().includes('suckerpunch') ||
        m.toLowerCase().includes('accelerock') ||
        m.toLowerCase().includes('vacuumwave') ||
        m.toLowerCase().includes('bulletpunch')
      );

      if (hasPriority) {
        speedOptionIndex = i;
        break;
      }

      // Check for Choice Scarf
      const hasScarf = mon.revealedItem?.toLowerCase().includes('choicescarf') || 
                       mon.revealedItem?.toLowerCase().includes('choice scarf');

      if (hasScarf) {
        speedOptionIndex = i;
        break;
      }

      // Check raw speed
      const speed = mon.stats?.spe || 85;
      if (speed > fastestSpeed) {
        fastestSpeed = speed;
        speedOptionIndex = i;
      }
    }

    if (speedOptionIndex === -1) return 0;

    const speedOption = state.myTeam[speedOptionIndex];
    const hpPercent = speedOption.currentHp && speedOption.maxHp
      ? speedOption.currentHp / speedOption.maxHp
      : 1.0;

    // Bonus if speed option is healthy
    if (hpPercent > 0.7) {
      score += 150;
    } else if (hpPercent < 0.4) {
      // Penalty if speed option is at risk
      score -= 200;
    }

    // Extra bonus if speed option is hidden (not revealed)
    if (speedOption.revealedMoves.size === 0) {
      score += 100;
    }

    return score;
  }

  /**
   * Hypothesis 6: Play faster when opponent has hazard advantage.
   * If opponent has hazards and we don't, play faster (reduce switch penalty).
   */
  private evaluateTempoSwitch(state: GameState): number {
    let score = 0;

    const myHazards =
      (state.hazards.opponent.stealthRock ? 1 : 0) +
      state.hazards.opponent.spikes +
      state.hazards.opponent.toxicSpikes;

    const oppHazards =
      (state.hazards.my.stealthRock ? 1 : 0) +
      state.hazards.my.spikes +
      state.hazards.my.toxicSpikes;

    const hazardDiff = myHazards - oppHazards;

    // If opponent has hazard advantage, we should play faster
    if (hazardDiff < 0) {
      // Reduce switch penalty by adding bonus for staying in
      score += Math.abs(hazardDiff) * 50;
    }

    // If we have hazard advantage, we can play slower
    if (hazardDiff > 0) {
      // Slight bonus for making opponent switch into hazards
      score += hazardDiff * 30;
    }

    return score;
  }
}

/**
 * Create challenger evaluators for gate testing.
 */
export function createChallenger(hypothesisId: string): ExpertEvaluator {
  const baseWeights = {
    material: 120,
    hp: 60,
    position: 25,
    hazards: 20,
    momentum: 15,
    information: 10,
  };

  switch (hypothesisId) {
    case 'hyp-hazard-differential':
      return new ExpertEvaluator(baseWeights, { hazardDifferential: true });
    
    case 'hyp-protect-hazard-setter':
      return new ExpertEvaluator(baseWeights, { protectHazardSetter: true });
    
    case 'hyp-resource-preservation':
      return new ExpertEvaluator(baseWeights, { resourcePreservation: true });
    
    case 'hyp-tera-second':
      return new ExpertEvaluator(baseWeights, { teraSecond: true });
    
    case 'hyp-speed-option-preservation':
      return new ExpertEvaluator(baseWeights, { speedOptionPreservation: true });
    
    case 'hyp-tempo-switch-hazard-disadvantage':
      return new ExpertEvaluator(baseWeights, { tempoSwitch: true });
    
    default:
      throw new Error(`Unknown hypothesis ID: ${hypothesisId}`);
  }
}
