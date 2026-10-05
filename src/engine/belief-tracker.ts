import { PokemonBelief, RandbatsStats, SpeciesStats } from '../types/index.js';
import { dataLoader } from '../data/data-loader.js';

export class BeliefTracker {
  private beliefs: Map<string, PokemonBelief> = new Map();
  private stats: RandbatsStats;

  constructor(stats?: RandbatsStats) {
    this.stats = stats ?? dataLoader.getStats();
  }

  initializeBelief(
    pokemonId: string,
    species: string,
    level: number
  ): PokemonBelief {
    const speciesStats = this.stats[species];
    if (!speciesStats) {
      return {
        species,
        level,
        possibleSets: new Map(),
        revealedMoves: new Set(),
      };
    }

    const possibleSets = new Map<string, number>();
    for (const [roleName, roleData] of Object.entries(speciesStats.roles || {})) {
      possibleSets.set(roleName, roleData.weight);
    }

    const belief: PokemonBelief = {
      species,
      level,
      possibleSets,
      revealedMoves: new Set(),
    };

    this.beliefs.set(pokemonId, belief);
    return belief;
  }

  updateOnMove(pokemonId: string, move: string): void {
    const belief = this.beliefs.get(pokemonId);
    if (!belief) return;

    belief.revealedMoves.add(move);

    const speciesStats = this.stats[belief.species];
    if (!speciesStats) return;

    const normalizedPossible = new Map<string, number>();
    for (const [roleName, prior] of belief.possibleSets.entries()) {
      const roleData = speciesStats.roles[roleName];
      if (!roleData) continue;

      const moveProb = roleData.moves[move] || 0;
      if (moveProb > 0) {
        normalizedPossible.set(roleName, prior * moveProb);
      }
    }

    this.normalizeProbabilities(normalizedPossible);
    belief.possibleSets = normalizedPossible;
  }

  updateOnAbility(pokemonId: string, ability: string): void {
    const belief = this.beliefs.get(pokemonId);
    if (!belief) return;

    belief.revealedAbility = ability;

    const speciesStats = this.stats[belief.species];
    if (!speciesStats) return;

    const abilityProb = speciesStats.abilities[ability] || 0;
    if (abilityProb > 0) {
      for (const [roleName, prior] of belief.possibleSets.entries()) {
        belief.possibleSets.set(roleName, prior * abilityProb);
      }
      this.normalizeProbabilities(belief.possibleSets);
    }
  }

  updateOnItem(pokemonId: string, item: string): void {
    const belief = this.beliefs.get(pokemonId);
    if (!belief) return;

    belief.revealedItem = item;

    const speciesStats = this.stats[belief.species];
    if (!speciesStats) return;

    const normalizedPossible = new Map<string, number>();
    for (const [roleName, prior] of belief.possibleSets.entries()) {
      const roleData = speciesStats.roles[roleName];
      if (!roleData?.items) continue;

      const itemProb = roleData.items[item] || 0;
      if (itemProb > 0) {
        normalizedPossible.set(roleName, prior * itemProb);
      }
    }

    this.normalizeProbabilities(normalizedPossible);
    belief.possibleSets = normalizedPossible;
  }

  updateOnTeraType(pokemonId: string, teraType: string): void {
    const belief = this.beliefs.get(pokemonId);
    if (!belief) return;

    belief.revealedTeraType = teraType;

    const speciesStats = this.stats[belief.species];
    if (!speciesStats) return;

    const normalizedPossible = new Map<string, number>();
    for (const [roleName, prior] of belief.possibleSets.entries()) {
      const roleData = speciesStats.roles[roleName];
      if (!roleData?.teraTypes) continue;

      const teraProb = roleData.teraTypes[teraType] || 0;
      if (teraProb > 0) {
        normalizedPossible.set(roleName, prior * teraProb);
      }
    }

    this.normalizeProbabilities(normalizedPossible);
    belief.possibleSets = normalizedPossible;
  }

  getBelief(pokemonId: string): PokemonBelief | undefined {
    return this.beliefs.get(pokemonId);
  }

  private normalizeProbabilities(probs: Map<string, number>): void {
    const total = Array.from(probs.values()).reduce((sum, p) => sum + p, 0);
    if (total > 0) {
      for (const [key, value] of probs.entries()) {
        probs.set(key, value / total);
      }
    }
  }

  sampleRole(pokemonId: string): string | null {
    const belief = this.beliefs.get(pokemonId);
    if (!belief || belief.possibleSets.size === 0) return null;

    const rand = Math.random();
    let cumulative = 0;
    for (const [role, prob] of belief.possibleSets.entries()) {
      cumulative += prob;
      if (rand < cumulative) {
        return role;
      }
    }

    return Array.from(belief.possibleSets.keys())[0];
  }
}
