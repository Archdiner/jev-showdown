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

    const myActive = newState.myTeam[newState.myActive];
    const oppActive = newState.opponentTeam[newState.opponentActive];
    
    if (!myActive || !oppActive) {
      return { state: newState, terminated: true, winner: 'p2' };
    }

    // Handle switches first (they go before moves)
    if (myAction.type === 'switch') {
      newState.myActive = myAction.switchIndex - 1;
    }
    if (oppAction.type === 'switch') {
      newState.opponentActive = oppAction.switchIndex - 1;
    }

    // If both switched or one switched, return state after switches
    if (myAction.type === 'switch' || oppAction.type === 'switch') {
      return {
        state: newState,
        terminated: this.checkGameOver(newState),
        winner: this.getWinner(newState),
      };
    }

    // Both are moves - determine move order
    const mySpeed = myActive.stats?.spe || 100;
    const oppSpeed = oppActive.stats?.spe || 100;
    const myPriority = this.getMovePriority(myAction);
    const oppPriority = this.getMovePriority(oppAction);
    
    const myFirst = myPriority > oppPriority || 
                    (myPriority === oppPriority && mySpeed > oppSpeed);

    // Execute moves in order
    if (myFirst) {
      this.executeMove(newState, 'p1', myAction);
      if (!this.checkGameOver(newState)) {
        this.executeMove(newState, 'p2', oppAction);
      }
    } else {
      this.executeMove(newState, 'p2', oppAction);
      if (!this.checkGameOver(newState)) {
        this.executeMove(newState, 'p1', myAction);
      }
    }

    return {
      state: newState,
      terminated: this.checkGameOver(newState),
      winner: this.getWinner(newState),
    };
  }

  private executeMove(state: GameState, player: 'p1' | 'p2', action: Action): void {
    if (action.type !== 'move') return;

    const attacker = player === 'p1' 
      ? state.myTeam[state.myActive]
      : state.opponentTeam[state.opponentActive];
    const defender = player === 'p1'
      ? state.opponentTeam[state.opponentActive]
      : state.myTeam[state.myActive];

    if (!attacker || !defender || !attacker.revealedMoves) return;

    // Get move
    const moves = this.getMoveNames(attacker);
    const moveIndex = action.moveIndex - 1;
    if (moveIndex < 0 || moveIndex >= moves.length) return;

    const moveName = moves[moveIndex];
    if (!moveName) return;
    
    // Calculate damage
    const damage = this.estimateDamage(attacker, defender, moveName);
    
    // Apply damage
    const currentHp = defender.currentHp || defender.maxHp || 100;
    const maxHp = defender.maxHp || 100;
    const newHp = Math.max(0, currentHp - damage);
    
    defender.currentHp = newHp;
    defender.maxHp = maxHp;

    // Check if fainted
    if (newHp === 0) {
      // Mark as fainted (in real implementation, would need to force switch)
      // For now, just leave HP at 0
    }
  }

  private getMovePriority(action: Action): number {
    // Simplified: most moves are priority 0
    // In real implementation, would check move data
    return 0;
  }

  private checkGameOver(state: GameState): boolean {
    const myAlive = state.myTeam.filter(m => 
      m.species !== 'Unknown' && (m.currentHp === undefined || m.currentHp > 0)
    ).length;
    const oppAlive = state.opponentTeam.filter(m =>
      m.species !== 'Unknown' && (m.currentHp === undefined || m.currentHp > 0)
    ).length;
    
    return myAlive === 0 || oppAlive === 0;
  }

  private getWinner(state: GameState): 'p1' | 'p2' | undefined {
    const myAlive = state.myTeam.filter(m =>
      m.species !== 'Unknown' && (m.currentHp === undefined || m.currentHp > 0)
    ).length;
    const oppAlive = state.opponentTeam.filter(m =>
      m.species !== 'Unknown' && (m.currentHp === undefined || m.currentHp > 0)
    ).length;
    
    if (myAlive === 0) return 'p2';
    if (oppAlive === 0) return 'p1';
    return undefined;
  }

  private cloneState(state: GameState): GameState {
    // Deep clone with Set preservation
    return {
      ...state,
      myTeam: state.myTeam.map(mon => ({
        ...mon,
        revealedMoves: new Set(mon.revealedMoves),
        possibleSets: new Map(mon.possibleSets),
        moves: mon.moves ? [...mon.moves] : undefined,
      })),
      opponentTeam: state.opponentTeam.map(mon => ({
        ...mon,
        revealedMoves: new Set(mon.revealedMoves),
        possibleSets: new Map(mon.possibleSets),
        moves: mon.moves ? [...mon.moves] : undefined,
      })),
      field: { ...state.field, screens: { ...state.field.screens } },
      hazards: {
        my: { ...state.hazards.my },
        opponent: { ...state.hazards.opponent },
      },
    };
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
    // Ordered request slots. Index 0 is move 1, and a disabled slot keeps its place.
    if (Array.isArray(pokemon?.moves) && pokemon.moves.length > 0) {
      return pokemon.moves.map((name: unknown) => (typeof name === 'string' ? name : ''));
    }
    return pokemon?.revealedMoves ? Array.from(pokemon.revealedMoves) : [];
  }
}

export const simulator = new BattleSimulator();
