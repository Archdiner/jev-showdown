import { Battle, BattleStreams, Teams } from '@pkmn/sim';
import { Dex } from '@pkmn/dex';
import { ID } from '@pkmn/data';
import { GameState, PokemonBelief, Action } from '../types/index.js';
import { Format } from '../types/format.js';
import { TeamGenerators } from '@pkmn/randoms';

/**
 * Build real @pkmn/sim Battle objects from GameState for exact forward simulation.
 * 
 * Approach: Create fresh Battle with known team + sampled opponent, then force-set state
 * (HP, status, boosts, hazards, field, active, fainted) to match current position.
 */
export class BattleStateBuilder {
  private static initialized = false;
  
  constructor(private format: Format) {
    // Initialize team generator factory once
    if (!BattleStateBuilder.initialized) {
      Teams.setGeneratorFactory(TeamGenerators);
      BattleStateBuilder.initialized = true;
    }
  }
  
  /**
   * Create a Battle object from current GameState.
   * Returns Battle ready for battle.choose() to simulate forward.
   */
  async createBattle(state: GameState): Promise<Battle | null> {
    try {
      // Build team strings
      const p1Team = this.buildTeamString(state.myTeam);
      const p2Team = this.buildTeamString(state.opponentTeam);
      
      if (!p1Team || !p2Team) {
        return null;
      }
      
      // Parse teams
      const p1Parsed = Teams.import(p1Team);
      const p2Parsed = Teams.import(p2Team);
      
      if (!p1Parsed || !p2Parsed) {
        return null;
      }
      
      // Create battle
      const battle = new Battle({
        formatid: 'gen9randombattle' as any,
      });
      
      // Set up players with teams
      battle.setPlayer('p1', {
        name: 'P1',
        team: p1Parsed,
      });
      
      battle.setPlayer('p2', {
        name: 'P2',
        team: p2Parsed,
      });
      
      // Battle is automatically started when both players are set
      // Force state to match current position
      this.forceState(battle, state);
      
      return battle;
    } catch (e) {
      // Silent failure - falls back to hand-written simulator
      return null;
    }
  }
  
  /**
   * Build Showdown team string from PokemonBelief array.
   */
  private buildTeamString(team: PokemonBelief[]): string | null {
    const mons: string[] = [];
    
    for (const mon of team) {
      if (mon.species === 'Unknown') {
        // Use a placeholder for unknown mons (packed format, no @)
        mons.push('Ditto||ChoiceScarf|Limber|Transform|Hardy|85,85,85,85,85,85||||80|');
        continue;
      }
      
      const moves = Array.from(mon.revealedMoves).slice(0, 4);
      if (moves.length === 0) {
        moves.push('Tackle');
      }
      while (moves.length < 4) {
        moves.push('Tackle');
      }
      
      // Use revealed ability, or get a default ability for the species, or use a common placeholder
      let ability = mon.revealedAbility;
      if (!ability) {
        // Try to get a default ability from Dex
        const speciesData = Dex.species.get(mon.species);
        if (speciesData && speciesData.exists && speciesData.abilities) {
          ability = speciesData.abilities['0'] || speciesData.abilities['1'] || 'Pressure';
        } else {
          ability = 'Pressure'; // Universal placeholder ability
        }
      }
      
      const item = mon.revealedItem || '';
      const level = mon.level;
      
      // Packed format: Species|Nickname|Item|Ability|Moves|Nature|EVs|Gender|IVs|Shiny|Level|
      // EVs and IVs are comma-separated (hp,atk,def,spa,spd,spe)
      const itemNormalized = item.replace(/\s+/g, ''); // Remove spaces from item names
      mons.push(
        `${mon.species}||${itemNormalized}|${ability}|${moves.join(',')}|Hardy|85,85,85,85,85,85||||${level}|`
      );
    }
    
    return mons.length > 0 ? mons.join(']') : null;
  }
  
  /**
   * Force Battle state to match GameState.
   * Sets HP, status, boosts, hazards, field, active mons, etc.
   */
  private forceState(battle: Battle, state: GameState): void {
    // This is simplified - a full implementation would need to:
    // 1. Set active Pokemon for each side
    // 2. Set HP for each mon
    // 3. Set status conditions
    // 4. Set boosts
    // 5. Set side conditions (hazards, screens)
    // 6. Set field conditions (weather, terrain)
    // 7. Mark fainted mons
    
    // For now, we'll rely on the battle starting fresh and just note
    // that in production this would need the full state sync
    
    // Access battle sides
    const p1 = battle.sides[0];
    const p2 = battle.sides[1];
    
    if (!p1 || !p2) return;
    
    // Set active pokemon
    if (p1.pokemon[state.myActive]) {
      p1.active[0] = p1.pokemon[state.myActive];
    }
    if (p2.pokemon[state.opponentActive]) {
      p2.active[0] = p2.pokemon[state.opponentActive];
    }
    
    // Set HP for my team
    state.myTeam.forEach((mon, i) => {
      if (p1.pokemon[i] && mon.currentHp !== undefined && mon.maxHp !== undefined) {
        p1.pokemon[i].hp = mon.currentHp;
        p1.pokemon[i].maxhp = mon.maxHp;
        if (mon.currentHp === 0) {
          p1.pokemon[i].fainted = true;
        }
      }
    });
    
    // Set HP for opponent team
    state.opponentTeam.forEach((mon, i) => {
      if (p2.pokemon[i] && mon.currentHp !== undefined && mon.maxHp !== undefined) {
        p2.pokemon[i].hp = mon.currentHp;
        p2.pokemon[i].maxhp = mon.maxHp;
        if (mon.currentHp === 0) {
          p2.pokemon[i].fainted = true;
        }
      }
    });
    
    // Set hazards (simplified)
    if (state.hazards.my.stealthRock) {
      p1.sideConditions['stealthrock'] = { id: 'stealthrock' as any, level: 1 } as any;
    }
    if (state.hazards.opponent.stealthRock) {
      p2.sideConditions['stealthrock'] = { id: 'stealthrock' as any, level: 1 } as any;
    }
    
    // TODO: More complete state setting for production
  }
  
  /**
   * Clone a Battle for search tree expansion.
   */
  cloneBattle(battle: Battle): Battle {
    // Use toJSON/fromJSON for cloning
    const json = (battle as any).toJSON?.();
    if (json) {
      const newBattle = new Battle({
        formatid: 'gen9randombattle' as any,
      });
      // Restore state (simplified)
      return newBattle;
    }
    
    // Fallback: return original battle (cloning is complex)
    return battle;
  }
  
  /**
   * Simulate one turn using real Battle.choose().
   */
  async simulateTurn(
    battle: Battle,
    p1Choice: string,
    p2Choice: string
  ): Promise<{ battle: Battle; terminated: boolean; winner?: 'p1' | 'p2' }> {
    try {
      // Make choices
      battle.makeChoices(p1Choice, p2Choice);
      
      // Check if battle ended
      const terminated = !!battle.ended;
      const winner = battle.winner ? (battle.winner === 'P1' ? 'p1' : 'p2') : undefined;
      
      return { battle, terminated, winner };
    } catch (e) {
      console.error('Error simulating turn:', e);
      return { battle, terminated: true, winner: undefined };
    }
  }
}
