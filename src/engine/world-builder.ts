import { Battle, BattleStreams, Dex, Teams } from '@pkmn/sim';
import { GameState, Action, PokemonBelief } from '../types/index.js';
import { Format } from '../types/format.js';

/**
 * Build determinized worlds from a game state.
 * Each world samples opponent hidden information (unrevealed sets, unknown mons).
 */
export class WorldBuilder {
  constructor(private format: Format) {}
  
  /**
   * Create N determinized worlds by sampling opponent sets.
   */
  buildWorlds(state: GameState, count: number): GameState[] {
    const worlds: GameState[] = [];
    
    for (let i = 0; i < count; i++) {
      worlds.push(this.buildWorld(state));
    }
    
    return worlds;
  }
  
  /**
   * Build one determinized world.
   */
  private buildWorld(state: GameState): GameState {
    // Deep clone while preserving Sets
    const world: GameState = this.cloneGameState(state);
    
    // Sample opponent's active pokemon if needed
    if (world.opponentTeam[world.opponentActive].species !== 'Unknown') {
      const oppActive = world.opponentTeam[world.opponentActive];
      const sampled = this.format.sampleSet(oppActive);
      
      if (sampled) {
        // Fill in unrevealed moves
        if (oppActive.revealedMoves.size < 4) {
          for (const move of sampled.moves) {
            oppActive.revealedMoves.add(move);
          }
        }
        
        // Set stats if not already known
        if (!oppActive.stats) {
          oppActive.stats = this.format.calculateStats(oppActive.species, oppActive.level) || undefined;
        }
      }
    }
    
    // Sample unrevealed opponent slots from species pool
    for (let i = 0; i < world.opponentTeam.length; i++) {
      if (world.opponentTeam[i].species === 'Unknown') {
        // For now, leave as Unknown
        // TODO: Sample from remaining species pool
      }
    }
    
    return world;
  }
  
  /**
   * Convert GameState to a @pkmn/sim Battle for exact mechanics.
   * This allows us to simulate actions using the real game engine.
   */
  async createBattle(state: GameState): Promise<Battle | null> {
    try {
      const format = 'gen9randombattle';
      
      // Build team strings
      const p1Team = this.buildTeamString(state.myTeam, state.myActive);
      const p2Team = this.buildTeamString(state.opponentTeam, state.opponentActive);
      
      if (!p1Team || !p2Team) {
        return null;
      }
      
      // Create battle stream
      const streams = BattleStreams.getPlayerStreams(new BattleStreams.BattleStream());
      
      // Battle construction is complex, skip for now
      // const battle = new Battle({
      //   formatid: format as any,
      //   seed: [Math.random() * 0x10000, Math.random() * 0x10000, Math.random() * 0x10000, Math.random() * 0x10000] as any,
      // });
      
      // Note: Full battle recreation is complex and may not be necessary
      // For now, we'll use a simpler simulation approach
      return null;
    } catch (e) {
      console.error('Error creating battle:', e);
      return null;
    }
  }
  
  private buildTeamString(team: PokemonBelief[], activeIndex: number): string | null {
    const mons: string[] = [];
    
    for (const mon of team) {
      if (mon.species === 'Unknown') {
        // Use a placeholder
        mons.push('Ditto @ Choice Scarf|Imposter|85,85,85,85,85,85|||85,85,85,85,85,85|N|');
        continue;
      }
      
      const moves = Array.from(mon.revealedMoves).slice(0, 4);
      if (moves.length === 0) {
        moves.push('tackle');
      }
      while (moves.length < 4) {
        moves.push('tackle');
      }
      
      const stats = mon.stats || this.format.calculateStats(mon.species, mon.level);
      if (!stats) continue;
      
      // Showdown team format: Species @ Item | Ability | Moves | Nature | EVs | IVs | Level
      const ability = mon.revealedAbility || 'noability';
      const item = mon.revealedItem || '';
      const level = mon.level;
      
      mons.push(
        `${mon.species}${item ? ` @ ${item}` : ''}|${ability}|${moves.join(',')}|Hardy|85,85,85,85,85,85|||${level}|`
      );
    }
    
    return mons.length > 0 ? mons.join(']') : null;
  }
  
  private cloneGameState(state: GameState): GameState {
    // Clone with Set preservation
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
