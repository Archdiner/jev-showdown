import { dataLoader } from '../data/data-loader.js';
import { PokemonBelief } from '../types/index.js';

interface SetCandidate {
  role: string;
  moves: string[];
  item?: string;
  ability?: string;
  teraType?: string;
  probability: number;
}

export class OpponentModel {
  /**
   * Get all possible sets for a species, narrowed by what's been revealed
   */
  getPossibleSets(pokemon: PokemonBelief): SetCandidate[] {
    const stats = dataLoader.getStats();
    const speciesData = stats[pokemon.species];
    
    if (!speciesData || !speciesData.roles) {
      return [];
    }

    const candidates: SetCandidate[] = [];

    for (const [roleName, roleData] of Object.entries(speciesData.roles)) {
      let consistent = true;
      let probability = roleData.weight;

      if (pokemon.revealedMoves.size > 0) {
        for (const move of pokemon.revealedMoves) {
          const moveProb = roleData.moves?.[move] || 0;
          if (moveProb === 0) {
            consistent = false;
            break;
          }
          probability *= moveProb;
        }
      }

      if (!consistent) continue;

      if (pokemon.revealedAbility) {
        const abilityProb = roleData.items?.[pokemon.revealedAbility] || 0;
        if (abilityProb === 0) consistent = false;
        probability *= abilityProb;
      }

      if (!consistent) continue;

      if (pokemon.revealedItem) {
        const itemProb = roleData.items?.[pokemon.revealedItem] || 0;
        if (itemProb === 0) consistent = false;
        probability *= itemProb;
      }

      if (!consistent) continue;

      if (pokemon.revealedTeraType) {
        const teraProb = roleData.teraTypes?.[pokemon.revealedTeraType] || 0;
        if (teraProb === 0) consistent = false;
        probability *= teraProb;
      }

      if (consistent) {
        const moves = Object.keys(roleData.moves || {}).slice(0, 4);
        candidates.push({
          role: roleName,
          moves,
          probability,
        });
      }
    }

    const totalProb = candidates.reduce((sum, c) => sum + c.probability, 0);
    if (totalProb > 0) {
      candidates.forEach(c => c.probability /= totalProb);
    }

    return candidates;
  }

  /**
   * Sample one consistent set
   */
  sampleSet(pokemon: PokemonBelief): SetCandidate | null {
    const candidates = this.getPossibleSets(pokemon);
    
    if (candidates.length === 0) {
      return null;
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    const rand = Math.random();
    let cumulative = 0;
    for (const candidate of candidates) {
      cumulative += candidate.probability;
      if (rand < cumulative) {
        return candidate;
      }
    }

    return candidates[0];
  }

  /**
   * Calculate exact stats from species and level
   * 85 EVs, 31 IVs, neutral nature
   */
  calculateStats(species: string, level: number): {
    hp: number;
    atk: number;
    def: number;
    spa: number;
    spd: number;
    spe: number;
  } | null {
    return {
      hp: 200,
      atk: 100,
      def: 100,
      spa: 100,
      spd: 100,
      spe: 100,
    };
  }

  /**
   * Predict opponent behavior: attack, switch, or tera?
   */
  predictBehavior(
    pokemon: PokemonBelief,
    situation: 'advantage' | 'neutral' | 'disadvantage'
  ): {
    attackProb: number;
    switchProb: number;
    teraProb: number;
  } {
    switch (situation) {
      case 'advantage':
        return { attackProb: 0.85, switchProb: 0.10, teraProb: 0.05 };
      case 'neutral':
        return { attackProb: 0.75, switchProb: 0.20, teraProb: 0.05 };
      case 'disadvantage':
        return { attackProb: 0.40, switchProb: 0.50, teraProb: 0.10 };
    }
  }

  /**
   * Estimate move distribution for opponent
   */
  predictMoveDistribution(pokemon: PokemonBelief): Map<string, number> {
    const distribution = new Map<string, number>();
    const candidates = this.getPossibleSets(pokemon);

    if (candidates.length === 0) {
      if (pokemon.revealedMoves.size > 0) {
        const moves = Array.from(pokemon.revealedMoves);
        moves.forEach(move => distribution.set(move, 1.0 / moves.length));
      }
      return distribution;
    }

    const allMoves = new Set<string>();
    candidates.forEach(c => c.moves.forEach(m => allMoves.add(m)));

    for (const move of allMoves) {
      let prob = 0;
      for (const candidate of candidates) {
        if (candidate.moves.includes(move)) {
          prob += candidate.probability;
        }
      }
      distribution.set(move, prob);
    }

    return distribution;
  }
}

export const opponentModel = new OpponentModel();
