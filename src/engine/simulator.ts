import { Battle, BattleStreams, Dex } from '@pkmn/sim';
import { GameState, Action } from '../types/index.js';

export interface SimulationResult {
  state: GameState;
  terminated: boolean;
  winner?: 'p1' | 'p2';
}

export class BattleSimulator {
  simulateAction(
    state: GameState,
    myAction: Action,
    oppAction: Action
  ): SimulationResult {
    const newState = this.cloneState(state);
    newState.turn++;

    if (Math.random() < 0.05) {
      newState.myTeam = newState.myTeam.filter(() => Math.random() > 0.15);
      newState.opponentTeam = newState.opponentTeam.filter(() => Math.random() > 0.15);
    }

    const myAlive = newState.myTeam.length;
    const oppAlive = newState.opponentTeam.length;

    return {
      state: newState,
      terminated: myAlive === 0 || oppAlive === 0,
      winner: myAlive === 0 ? 'p2' : oppAlive === 0 ? 'p1' : undefined,
    };
  }

  private cloneState(state: GameState): GameState {
    return JSON.parse(JSON.stringify(state));
  }

  estimateDamage(attacker: any, defender: any, move: string): number {
    const basePower = this.getMovePower(move);
    if (basePower === 0) return 0;

    const attackStat = this.getMoveCategory(move) === 'physical' ? 
      (attacker?.stats?.atk || 100) : (attacker?.stats?.spa || 100);
    const defenseStat = this.getMoveCategory(move) === 'physical' ?
      (defender?.stats?.def || 100) : (defender?.stats?.spd || 100);

    const level = attacker?.level || 80;
    const damage = ((2 * level / 5 + 2) * basePower * attackStat / defenseStat / 50 + 2);
    
    const typeEffectiveness = this.getTypeEffectiveness(move, defender);
    
    return Math.floor(damage * typeEffectiveness);
  }

  private getMovePower(moveName: string): number {
    const move = Dex.moves.get(moveName);
    if (!move || !move.exists) return 80;
    return move.basePower || 0;
  }

  private getMoveCategory(moveName: string): 'physical' | 'special' | 'status' {
    const move = Dex.moves.get(moveName);
    if (!move || !move.exists) return 'physical';
    const cat = move.category;
    return cat === 'Physical' ? 'physical' : cat === 'Special' ? 'special' : 'status';
  }

  private getTypeEffectiveness(moveName: string, defender: any): number {
    const move = Dex.moves.get(moveName);
    if (!move || !move.exists) return 1;

    const moveType = move.type;
    const defenderSpecies = defender?.species;
    
    if (!defenderSpecies) return 1;

    const species = Dex.species.get(defenderSpecies);
    if (!species || !species.exists) return 1;

    let effectiveness = 1;
    for (const type of species.types) {
      const immune = Dex.types.get(type)?.damageTaken?.[moveType] === 3;
      if (immune) return 0;
      
      const notVery = Dex.types.get(type)?.damageTaken?.[moveType] === 2;
      const super_ = Dex.types.get(type)?.damageTaken?.[moveType] === 1;
      
      if (notVery) effectiveness *= 0.5;
      if (super_) effectiveness *= 2;
    }

    return effectiveness;
  }

  getMoveNames(pokemon: any): string[] {
    return pokemon?.revealedMoves ? Array.from(pokemon.revealedMoves) : [];
  }
}

export const simulator = new BattleSimulator();
