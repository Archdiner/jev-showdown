import { Battle } from '@pkmn/sim';
import { Action, GameState, PokemonBelief } from '../types/index.js';

export interface SimulationState {
  battle: Battle;
  myPerspective: 'p1' | 'p2';
}

export interface SimulationResult {
  winner?: 'p1' | 'p2';
  state: string;
  terminated: boolean;
}

export class BattleSimulator {
  /**
   * Apply actions from both sides and return the resulting battle state
   */
  applyActions(
    battleState: string,
    myAction: string,
    oppAction: string
  ): SimulationResult {
    return {
      state: battleState,
      terminated: false,
    };
  }

  /**
   * Sample a plausible opponent team from beliefs
   */
  sampleOpponentTeam(beliefs: PokemonBelief[]): any[] {
    return beliefs.map(belief => {
      if (belief.species === 'Unknown') {
        return null;
      }
      
      const roles = Array.from(belief.possibleSets.entries());
      let selectedRole = 'Fast Attacker';
      
      if (roles.length > 0) {
        const rand = Math.random();
        let cumulative = 0;
        for (const [role, prob] of roles) {
          cumulative += prob;
          if (rand < cumulative) {
            selectedRole = role;
            break;
          }
        }
      }
      
      const moves = belief.revealedMoves.size > 0 
        ? Array.from(belief.revealedMoves)
        : ['tackle', 'bodyslam'];
      
      return {
        species: belief.species,
        level: belief.level,
        role: selectedRole,
        moves: moves.slice(0, 4),
      };
    }).filter(x => x !== null);
  }

  /**
   * Model opponent behavior: what action will they likely take?
   */
  predictOpponentAction(
    state: GameState,
    oppLegalMoves: string[]
  ): string[] {
    const predictions: string[] = [];
    
    const oppActive = state.opponentTeam[state.opponentActive];
    if (!oppActive) {
      return oppLegalMoves;
    }
    
    const switchLikelihood = 0.15;
    const hasSwitch = state.opponentTeam.filter(m => m.species !== 'Unknown').length > 1;
    
    if (hasSwitch && Math.random() < switchLikelihood) {
      for (let i = 1; i < state.opponentTeam.length; i++) {
        if (state.opponentTeam[i].species !== 'Unknown') {
          predictions.push(`switch ${i + 1}`);
        }
      }
    }
    
    for (const move of oppLegalMoves) {
      predictions.push(move);
    }
    
    return predictions.length > 0 ? predictions : oppLegalMoves;
  }
}

export const battleSim = new BattleSimulator();
