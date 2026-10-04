import { Dex } from '@pkmn/sim';
import {
  Format,
  SetCandidate,
  PokemonStats,
  BehaviorPrediction,
  OpponentTracking,
  StateMismatch,
} from '../types/format.js';
import {
  Action,
  GameState,
  PokemonBelief,
  EvaluatorWeights,
  RandbatsStats,
} from '../types/index.js';

/**
 * Gen 9 Random Battle format implementation.
 * 
 * Key properties:
 * - 85 EVs across all stats
 * - 31 IVs across all stats
 * - Neutral nature
 * - Species pools with role-based sets
 * - Known level distribution per species
 */
export class Gen9RandomBattle implements Format {
  readonly id = 'gen9randombattle';
  readonly name = 'Gen 9 Random Battle';
  
  dataSources = {
    setsUrl: 'https://raw.githubusercontent.com/smogon/pokemon-showdown/master/data/random-battles/gen9/sets.json',
    statsUrl: 'https://pkmn.github.io/randbats/data/stats/gen9randombattle.json',
    rulesUrl: 'https://raw.githubusercontent.com/smogon/pokemon-showdown/master/config/formats.ts',
  };
  
  private sets: Record<string, any> = {};
  private stats: RandbatsStats = {};
  
  async initialize(data: { sets: any; stats: any }): Promise<void> {
    this.sets = data.sets;
    this.stats = data.stats;
  }
  
  getPossibleSets(pokemon: PokemonBelief): SetCandidate[] {
    const speciesData = this.stats[pokemon.species];
    
    if (!speciesData || !speciesData.roles) {
      return [];
    }
    
    const candidates: SetCandidate[] = [];
    
    for (const [roleName, roleData] of Object.entries(speciesData.roles)) {
      let consistent = true;
      let probability = roleData.weight;
      
      // Strict role narrowing: Check revealed moves
      if (pokemon.revealedMoves.size > 0) {
        for (const move of pokemon.revealedMoves) {
          // If this role doesn't have this move at all, it's eliminated
          const moveProb = roleData.moves?.[move] || 0;
          if (moveProb === 0) {
            consistent = false;
            break;
          }
          probability *= moveProb;
        }
      }
      
      if (!consistent) continue;
      
      // Strict role narrowing: Check revealed ability
      if (pokemon.revealedAbility) {
        // Ability is in roleData.abilities, not items (fixing bug)
        const abilityProb = roleData.abilities?.[pokemon.revealedAbility] || 0;
        if (abilityProb === 0) {
          consistent = false;
        } else {
          probability *= abilityProb;
        }
      }
      
      if (!consistent) continue;
      
      // Strict role narrowing: Check revealed item
      if (pokemon.revealedItem) {
        const itemProb = roleData.items?.[pokemon.revealedItem] || 0;
        if (itemProb === 0) {
          consistent = false;
        } else {
          probability *= itemProb;
        }
      }
      
      if (!consistent) continue;
      
      // Strict role narrowing: Check revealed Tera type
      if (pokemon.revealedTeraType) {
        const teraProb = roleData.teraTypes?.[pokemon.revealedTeraType] || 0;
        if (teraProb === 0) {
          consistent = false;
        } else {
          probability *= teraProb;
        }
      }
      
      if (consistent) {
        const moves = Object.keys(roleData.moves || {}).slice(0, 4);
        const items = Object.keys(roleData.items || {});
        const abilities = Object.keys(roleData.abilities || {});
        const teraTypes = Object.keys(roleData.teraTypes || {});
        
        candidates.push({
          role: roleName,
          moves,
          item: items[0] || '',
          ability: pokemon.revealedAbility || abilities[0] || '',
          teraType: teraTypes[0] || '',
          probability,
        });
      }
    }
    
    // Normalize probabilities
    const totalProb = candidates.reduce((sum, c) => sum + c.probability, 0);
    if (totalProb > 0) {
      candidates.forEach(c => c.probability /= totalProb);
    }
    
    return candidates;
  }
  
  /**
   * Validate team generation constraints (Gen 9 Random Battle rules).
   * Returns null if valid, or an array of constraint violations.
   */
  validateTeamConstraints(team: PokemonBelief[]): string[] | null {
    const violations: string[] = [];
    
    // Filter out Unknown and fainted mons
    const knownTeam = team.filter(mon => mon.species !== 'Unknown' && (!mon.currentHp || mon.currentHp > 0));
    
    if (knownTeam.length === 0) {
      return null;
    }
    
    // Constraint 1: Max 2 mons per type
    const typeCount: Record<string, number> = {};
    for (const mon of knownTeam) {
      const species = Dex.species.get(mon.species);
      if (!species.exists) continue;
      
      for (const type of species.types) {
        typeCount[type] = (typeCount[type] || 0) + 1;
        if (typeCount[type] > 2) {
          violations.push(`More than 2 ${type}-type mons (found ${typeCount[type]})`);
        }
      }
    }
    
    // Constraint 2: Max 3 mons weak to one type
    const weaknessCount: Record<string, number> = {};
    for (const mon of knownTeam) {
      const species = Dex.species.get(mon.species);
      if (!species.exists) continue;
      
      // Calculate weaknesses (types that deal >1x damage)
      for (const attackType of Object.keys(Dex.types.all())) {
        let effectiveness = 1.0;
        for (const defenseType of species.types) {
          const typeData = Dex.types.get(defenseType);
          if (typeData.damageTaken && typeData.damageTaken[attackType] !== undefined) {
            const dt = typeData.damageTaken[attackType];
            if (dt === 1) effectiveness *= 2;      // Weak
            else if (dt === 2) effectiveness *= 0.5; // Resist
            else if (dt === 3) effectiveness *= 0;   // Immune
          }
        }
        
        if (effectiveness > 1.0) {
          weaknessCount[attackType] = (weaknessCount[attackType] || 0) + 1;
          if (weaknessCount[attackType] > 3) {
            violations.push(`More than 3 mons weak to ${attackType} (found ${weaknessCount[attackType]})`);
          }
        }
      }
    }
    
    // Constraint 3: No shared 4x weakness
    const fourXWeaknesses: string[][] = [];
    for (const mon of knownTeam) {
      const species = Dex.species.get(mon.species);
      if (!species.exists) continue;
      
      const monWeaknesses: string[] = [];
      for (const attackType of Object.keys(Dex.types.all())) {
        let effectiveness = 1.0;
        for (const defenseType of species.types) {
          const typeData = Dex.types.get(defenseType);
          if (typeData.damageTaken && typeData.damageTaken[attackType] !== undefined) {
            const dt = typeData.damageTaken[attackType];
            if (dt === 1) effectiveness *= 2;
            else if (dt === 2) effectiveness *= 0.5;
            else if (dt === 3) effectiveness *= 0;
          }
        }
        
        if (effectiveness >= 4.0) {
          monWeaknesses.push(attackType);
        }
      }
      
      fourXWeaknesses.push(monWeaknesses);
    }
    
    // Check for shared 4x weaknesses
    for (let i = 0; i < fourXWeaknesses.length; i++) {
      for (let j = i + 1; j < fourXWeaknesses.length; j++) {
        const shared = fourXWeaknesses[i].filter(w => fourXWeaknesses[j].includes(w));
        if (shared.length > 0) {
          violations.push(`Shared 4x weakness to ${shared.join(', ')} between ${knownTeam[i].species} and ${knownTeam[j].species}`);
        }
      }
    }
    
    // Constraint 4: Max 1 Tera Blast role per team
    // Note: This requires role data which we check during set generation
    // For now, we'll document this constraint but can't validate without role info
    
    return violations.length > 0 ? violations : null;
  }
  
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
  
  calculateStats(species: string, level: number): PokemonStats | null {
    const dexSpecies = Dex.species.get(species);
    if (!dexSpecies || !dexSpecies.exists) {
      return null;
    }
    
    const baseStats = dexSpecies.baseStats;
    
    // Gen 9 Randbats: 85 EVs, 31 IVs, neutral nature
    const EV = 85;
    const IV = 31;
    
    const hp = Math.floor(((2 * baseStats.hp + IV + Math.floor(EV / 4)) * level) / 100) + level + 10;
    const atk = Math.floor(((2 * baseStats.atk + IV + Math.floor(EV / 4)) * level) / 100) + 5;
    const def = Math.floor(((2 * baseStats.def + IV + Math.floor(EV / 4)) * level) / 100) + 5;
    const spa = Math.floor(((2 * baseStats.spa + IV + Math.floor(EV / 4)) * level) / 100) + 5;
    const spd = Math.floor(((2 * baseStats.spd + IV + Math.floor(EV / 4)) * level) / 100) + 5;
    const spe = Math.floor(((2 * baseStats.spe + IV + Math.floor(EV / 4)) * level) / 100) + 5;
    
    return { hp, atk, def, spa, spd, spe };
  }
  
  getLegalActions(request: any): Action[] {
    const actions: Action[] = [];
    
    // Force switch (mon fainted)
    if (request.forceSwitch) {
      if (request.side && request.side.pokemon) {
        const activeIndex = request.side.pokemon.findIndex((p: any) => p.active);
        
        for (let i = 0; i < request.side.pokemon.length; i++) {
          if (i === activeIndex) continue;
          const mon = request.side.pokemon[i];
          if (mon.condition && !mon.condition.includes('fnt')) {
            actions.push({ type: 'switch', switchIndex: i + 1 });
          }
        }
      }
      
      if (actions.length === 0) {
        for (let i = 2; i <= 6; i++) {
          actions.push({ type: 'switch', switchIndex: i });
        }
      }
      return actions;
    }
    
    // Normal turn: moves + optional switches
    if (request.active && request.active[0]) {
      const active = request.active[0];
      
      // Add legal moves
      if (active.moves) {
        for (let i = 0; i < active.moves.length; i++) {
          const move = active.moves[i];
          const hasDisabled = move.disabled === true;
          const hasNoPP = move.pp !== undefined && move.pp <= 0;
          if (!hasDisabled && !hasNoPP) {
            actions.push({ type: 'move', moveIndex: i + 1 });
          }
        }
      }
      
      // Add switches if not trapped
      if (request.side && request.side.pokemon && actions.length > 0 && !active.trapped) {
        const activeIndex = request.side.pokemon.findIndex((p: any) => p.active);
        
        for (let i = 0; i < request.side.pokemon.length; i++) {
          if (i === activeIndex) continue;
          const mon = request.side.pokemon[i];
          if (mon.condition && !mon.condition.includes('fnt')) {
            actions.push({ type: 'switch', switchIndex: i + 1 });
          }
        }
      }
    }
    
    // Fallback
    if (actions.length === 0) {
      return [{ type: 'move', moveIndex: 1 }];
    }
    
    return actions;
  }
  
  getEvaluatorWeights(): EvaluatorWeights {
    return {
      material: 120,  // Mon count is critical in randbats
      hp: 60,         // HP percentage important
      position: 25,   // Hazards matter but not as much as material
      hazards: 20,    // Stealth Rock especially
      momentum: 15,   // Screens/weather less common
      information: 10, // Knowing opponent sets helpful
    };
  }
  
  predictBehavior(
    pokemon: PokemonBelief,
    situation: 'advantage' | 'neutral' | 'disadvantage'
  ): BehaviorPrediction {
    switch (situation) {
      case 'advantage':
        return { attackProb: 0.85, switchProb: 0.10, teraProb: 0.05 };
      case 'neutral':
        return { attackProb: 0.75, switchProb: 0.20, teraProb: 0.05 };
      case 'disadvantage':
        return { attackProb: 0.40, switchProb: 0.50, teraProb: 0.10 };
    }
  }
  
  buildGameState(request: any, opponentTracking: OpponentTracking): GameState {
    // Build our team from request
    const myTeam = request.side?.pokemon?.map((p: any, i: number) => {
      const species = p.ident?.split(':')[1]?.trim().split(',')[0] || 
                      p.details?.split(',')[0] || 
                      'Unknown';
      const moves = new Set<string>();
      
      if (p.moves) {
        for (const moveName of p.moves) {
          moves.add(moveName);
        }
      }
      
      if (i === 0 && request.active?.[0]?.moves) {
        for (const move of request.active[0].moves) {
          if (move.id || move.move) {
            moves.add(move.id || move.move);
          }
        }
      }
      
      // Parse HP from condition (e.g., "100/100", "50/100 fnt")
      let currentHp = 100;
      let maxHp = 100;
      if (p.condition) {
        const hpMatch = p.condition.match(/(\d+)\/(\d+)/);
        if (hpMatch) {
          currentHp = parseInt(hpMatch[1]);
          maxHp = parseInt(hpMatch[2]);
        }
      }
      
      const belief: PokemonBelief = {
        species,
        level: p.level || 80,
        possibleSets: new Map(),
        revealedMoves: moves,
        stats: p.stats || this.calculateStats(species, p.level || 80) || undefined,
        currentHp,
        maxHp,
      };
      
      return belief;
    }) || [];
    
    // Build opponent team from tracking
    const opponentTeam: PokemonBelief[] = [];
    const activeSpecies = opponentTracking.activeSpecies || 'Unknown';
    
    // Add active opponent
    opponentTeam.push({
      species: activeSpecies,
      level: 80,
      possibleSets: new Map(),
      revealedMoves: opponentTracking.revealedMoves.get(activeSpecies) || new Set(),
      revealedAbility: opponentTracking.revealedAbilities.get(activeSpecies),
      revealedItem: opponentTracking.revealedItems.get(activeSpecies),
      stats: this.calculateStats(activeSpecies, 80) || undefined,
      currentHp: 100,
      maxHp: 100,
    });
    
    // Add unknown slots for rest of team
    for (let i = 1; i < 6; i++) {
      opponentTeam.push({
        species: 'Unknown',
        level: 80,
        possibleSets: new Map(),
        revealedMoves: new Set(),
      });
    }
    
    // Extract player ID from request
    const playerId: 'p1' | 'p2' = request.side?.id || 'p1';

    return {
      myTeam,
      opponentTeam,
      myActive: 0,
      opponentActive: 0,
      turn: request.turn || 1,
      myTeraUsed: false,
      opponentTeraUsed: false,
      field: {
        trickRoom: false,
        screens: {},
      },
      hazards: {
        my: { stealthRock: false, spikes: 0, toxicSpikes: 0 },
        opponent: { stealthRock: false, spikes: 0, toxicSpikes: 0 },
      },
      playerId,
    };
  }
  
  reconcileState(tracked: GameState, request: any): StateMismatch[] {
    const mismatches: StateMismatch[] = [];
    
    if (!request.side?.pokemon) {
      return mismatches;
    }
    
    // Check team size
    if (tracked.myTeam.length !== request.side.pokemon.length) {
      mismatches.push({
        field: 'myTeam.length',
        tracked: tracked.myTeam.length,
        actual: request.side.pokemon.length,
        severity: 'error',
      });
    }
    
    // Check each mon
    for (let i = 0; i < Math.min(tracked.myTeam.length, request.side.pokemon.length); i++) {
      const trackedMon = tracked.myTeam[i];
      const actualMon = request.side.pokemon[i];
      
      const actualSpecies = actualMon.ident?.split(':')[1]?.trim().split(',')[0] || 
                           actualMon.details?.split(',')[0];
      
      if (trackedMon.species !== actualSpecies && actualSpecies) {
        mismatches.push({
          field: `myTeam[${i}].species`,
          tracked: trackedMon.species,
          actual: actualSpecies,
          severity: 'error',
        });
      }
      
      // Check HP
      if (actualMon.condition) {
        const hpMatch = actualMon.condition.match(/(\d+)\/(\d+)/);
        if (hpMatch) {
          const actualHp = parseInt(hpMatch[1]);
          const actualMaxHp = parseInt(hpMatch[2]);
          
          if (trackedMon.currentHp !== actualHp) {
            mismatches.push({
              field: `myTeam[${i}].currentHp`,
              tracked: trackedMon.currentHp,
              actual: actualHp,
              severity: 'warning',
            });
          }
          
          if (trackedMon.maxHp !== actualMaxHp) {
            mismatches.push({
              field: `myTeam[${i}].maxHp`,
              tracked: trackedMon.maxHp,
              actual: actualMaxHp,
              severity: 'warning',
            });
          }
        }
      }
    }
    
    // Check active index
    const actualActiveIndex = request.side.pokemon.findIndex((p: any) => p.active);
    if (actualActiveIndex >= 0 && tracked.myActive !== actualActiveIndex) {
      mismatches.push({
        field: 'myActive',
        tracked: tracked.myActive,
        actual: actualActiveIndex,
        severity: 'error',
      });
    }
    
    return mismatches;
  }
}

export const gen9RandomBattle = new Gen9RandomBattle();
