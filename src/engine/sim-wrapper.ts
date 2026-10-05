import { GameState, Action, PokemonBelief } from '../types/index.js';
import { Format } from '../types/format.js';
import { BattleStateBuilder } from './battle-state-builder.js';
import { simulator } from './simulator.js';

export interface SimResult {
  state: GameState;
  terminated: boolean;
  winner?: 'p1' | 'p2';
}

export class SimWrapper {
  private builder: BattleStateBuilder;
  private fallbackCount: number = 0;
  private totalCalls: number = 0;
  
  constructor(format: Format) {
    this.builder = new BattleStateBuilder(format);
  }
  
  getFallbackStats(): { fallbackCount: number; totalCalls: number; fallbackRate: number } {
    return {
      fallbackCount: this.fallbackCount,
      totalCalls: this.totalCalls,
      fallbackRate: this.totalCalls > 0 ? this.fallbackCount / this.totalCalls : 0,
    };
  }
  
  resetStats(): void {
    this.fallbackCount = 0;
    this.totalCalls = 0;
  }
  
  async simulateTurn(
    state: GameState,
    p1Action: Action,
    p2Action: Action
  ): Promise<SimResult> {
    this.totalCalls++;
    
    try {
      const battle = await this.builder.createBattle(state);
      
      if (!battle) {
        this.fallbackCount++;
        return simulator.simulateAction(state, p1Action, p2Action);
      }
      
      const p1Choice = this.actionToChoice(p1Action, state.myTeam[state.myActive]);
      const p2Choice = this.actionToChoice(p2Action, state.opponentTeam[state.opponentActive]);
      
      const result = await this.builder.simulateTurn(battle, p1Choice, p2Choice);
      
      const newState = this.extractStateFromBattle(result.battle, state);
      
      return {
        state: newState,
        terminated: result.terminated,
        winner: result.winner,
      };
    } catch (e) {
      this.fallbackCount++;
      return simulator.simulateAction(state, p1Action, p2Action);
    }
  }
  
  private actionToChoice(action: Action, pokemon: PokemonBelief): string {
    if (action.type === 'switch') {
      return `switch ${action.switchIndex}`;
    } else {
      let choice = `move ${action.moveIndex}`;
      if (action.terastallize) {
        choice += ' terastallize';
      }
      return choice;
    }
  }
  
  private extractStateFromBattle(battle: any, originalState: GameState): GameState {
    const newState = this.cloneState(originalState);
    newState.turn++;
    
    if (!battle.sides || battle.sides.length < 2) {
      return newState;
    }
    
    const p1 = battle.sides[0];
    const p2 = battle.sides[1];
    
    if (p1 && p1.pokemon) {
      p1.pokemon.forEach((mon: any, i: number) => {
        if (newState.myTeam[i] && mon) {
          newState.myTeam[i].currentHp = mon.hp;
          newState.myTeam[i].maxHp = mon.maxhp;
        }
      });
    }
    
    if (p2 && p2.pokemon) {
      p2.pokemon.forEach((mon: any, i: number) => {
        if (newState.opponentTeam[i] && mon) {
          newState.opponentTeam[i].currentHp = mon.hp;
          newState.opponentTeam[i].maxHp = mon.maxhp;
        }
      });
    }
    
    if (p1.active[0]) {
      const activeIndex = p1.pokemon.indexOf(p1.active[0]);
      if (activeIndex >= 0) {
        newState.myActive = activeIndex;
      }
    }
    
    if (p2.active[0]) {
      const activeIndex = p2.pokemon.indexOf(p2.active[0]);
      if (activeIndex >= 0) {
        newState.opponentActive = activeIndex;
      }
    }
    
    return newState;
  }
  
  private cloneState(state: GameState): GameState {
    return {
      ...state,
      myTeam: state.myTeam.map(mon => ({
        ...mon,
        revealedMoves: new Set(mon.revealedMoves),
        possibleSets: new Map(mon.possibleSets),
      })),
      opponentTeam: state.opponentTeam.map(mon => ({
        ...mon,
        revealedMoves: new Set(mon.revealedMoves),
        possibleSets: new Map(mon.possibleSets),
      })),
      field: { ...state.field, screens: { ...state.field.screens } },
      hazards: {
        my: { ...state.hazards.my },
        opponent: { ...state.hazards.opponent },
      },
    };
  }
}
