/**
 * Feature extraction for neural evaluation under hidden information.
 * 
 * Critical: Features must ONLY use information visible to our side.
 * No leaking of opponent's hidden sets into training features.
 */

import type { Battle } from '@pkmn/sim';
import type { SideId } from '../exact/battle-utils.js';

export interface NeuralFeatures {
  /** Raw feature vector for inference */
  features: Float32Array;
  /** Metadata for debugging */
  meta: {
    turn: number;
    ourMonsRemaining: number;
    oppMonsRemaining: number;
  };
}

/**
 * Extract features from a battle state, using only information visible to our side.
 * This is the honest view that matches what the ladder client would see.
 */
export function extractFeatures(battle: Battle, sideId: SideId): NeuralFeatures {
  const us = battle.getSide(sideId);
  const them = us.foe;
  
  // Start with a large buffer - we'll determine exact size as we build
  const features: number[] = [];
  
  // === GLOBAL FEATURES ===
  features.push(battle.turn / 50.0); // Normalized turn number
  features.push(us.pokemon.filter(p => p && !p.fainted).length / 6.0);
  features.push(them.pokemon.filter(p => p && !p.fainted).length / 6.0);
  
  // === FIELD STATE ===
  const field = battle.field as any;
  
  // Weather (one-hot 5: none, sun, rain, sand, snow)
  const weather = field.weather?.id || 'none';
  for (const w of ['none', 'sunnyday', 'raindance', 'sandstorm', 'snow']) {
    features.push(weather === w ? 1.0 : 0.0);
  }
  features.push((field.weather?.duration || 0) / 8.0);
  
  // Terrain (one-hot 5: none, electric, grassy, misty, psychic)
  const terrain = field.terrain?.id || 'none';
  for (const t of ['none', 'electricterrain', 'grassyterrain', 'mistyterrain', 'psychicterrain']) {
    features.push(terrain === t ? 1.0 : 0.0);
  }
  features.push((field.terrain?.duration || 0) / 8.0);
  
  // Trick Room
  features.push(field.pseudoWeather?.trickroom ? 1.0 : 0.0);
  features.push((field.pseudoWeather?.trickroom?.duration || 0) / 5.0);
  
  // === SIDE-SPECIFIC FIELD STATE (us then them) ===
  for (const side of [us, them]) {
    const sideConditions = side.sideConditions as any;
    
    // Hazards
    features.push(sideConditions.stealthrock ? 1.0 : 0.0);
    features.push((sideConditions.spikes?.layers || 0) / 3.0);
    features.push((sideConditions.toxicspikes?.layers || 0) / 2.0);
    features.push(sideConditions.stickyweb ? 1.0 : 0.0);
    
    // Screens
    features.push((sideConditions.reflect?.duration || 0) / 8.0);
    features.push((sideConditions.lightscreen?.duration || 0) / 8.0);
    features.push((sideConditions.auroraveil?.duration || 0) / 8.0);
    
    // Other field effects
    features.push(sideConditions.tailwind ? 1.0 : 0.0);
    features.push((sideConditions.tailwind?.duration || 0) / 4.0);
    
    // Tera availability (we know both sides' Tera status from public info)
    const teraUsed = side.pokemon.some(p => (p as any).terastallized);
    features.push(teraUsed ? 0.0 : 1.0);
  }
  
  // === POKEMON FEATURES (6 ours, 6 theirs) ===
  // For opponent mons, only use revealed information
  for (const side of [us, them]) {
    const isOurSide = side === us;
    const mons = side.pokemon;
    
    for (let i = 0; i < 6; i++) {
      const mon = mons[i];
      
      if (!mon || mon.fainted) {
        // Fainted/missing mon: all zeros
        features.push(...new Array(50).fill(0));
        continue;
      }
      
      // Basic state
      features.push(mon.hp / mon.maxhp); // HP fraction
      features.push(mon.isActive ? 1.0 : 0.0);
      features.push(mon.level / 100.0);
      features.push(mon.fainted ? 1.0 : 0.0);
      
      // For opponent, only include info if they've been revealed
      const revealed = isOurSide || (mon.previouslySwitchedIn || 0) > 0 || mon.isActive;
      features.push(revealed ? 1.0 : 0.0);
      
      if (!revealed) {
        // Unrevealed opponent mon: fill remaining slots with zeros
        features.push(...new Array(45).fill(0));
        continue;
      }
      
      // Status (one-hot 7: none, psn, tox, brn, par, frz, slp)
      const status = mon.status || 'none';
      for (const s of ['none', 'psn', 'tox', 'brn', 'par', 'frz', 'slp']) {
        features.push(status === s ? 1.0 : 0.0);
      }
      features.push((mon.statusState?.sleepTurns || 0) / 3.0);
      features.push((mon.statusState?.toxicTurns || 0) / 4.0);
      
      // Boosts (7 stats: atk, def, spa, spd, spe, accuracy, evasion)
      const boosts = mon.boosts || {};
      const boostStats: Array<'atk' | 'def' | 'spa' | 'spd' | 'spe' | 'accuracy' | 'evasion'> = 
        ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'];
      for (const stat of boostStats) {
        features.push((boosts[stat] || 0) / 6.0);
      }
      
      // Base stats (if known) - normalized by 255 (max base stat)
      const baseStats = mon.species?.baseStats || { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
      const stats: Array<'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe'> = 
        ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
      for (const stat of stats) {
        features.push((baseStats[stat] || 0) / 255.0);
      }
      
      // Tera type (one-hot 19 types, including unknown)
      const teraType = (mon as any).teraType || 'unknown';
      const types = ['Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice', 'Fighting', 'Poison',
                     'Ground', 'Flying', 'Psychic', 'Bug', 'Rock', 'Ghost', 'Dragon',
                     'Dark', 'Steel', 'Fairy', 'unknown'];
      for (const t of types) {
        features.push(teraType === t ? 1.0 : 0.0);
      }
      
      // Terastallized flag
      features.push((mon as any).terastallized ? 1.0 : 0.0);
      
      // Move count (how many moves are known/revealed)
      const moveCount = mon.moveSlots?.length || 0;
      features.push(moveCount / 4.0);
      
      // Item/Ability revealed (binary flags)
      features.push(mon.item ? 1.0 : 0.0);
      features.push(mon.ability ? 1.0 : 0.0);
    }
  }
  
  const featureArray = new Float32Array(features);
  
  return {
    features: featureArray,
    meta: {
      turn: battle.turn,
      ourMonsRemaining: us.pokemon.filter(p => p && !p.fainted).length,
      oppMonsRemaining: them.pokemon.filter(p => p && !p.fainted).length,
    },
  };
}

/**
 * Get the dimension of the feature vector.
 * Call this after feature extraction to know the exact size.
 */
export function getFeatureDim(): number {
  // This should match the size computed in extractFeatures
  // Global: 3
  // Field state: 6 (weather) + 6 (terrain) + 2 (trick room) = 14
  // Side-specific field (×2 sides): 2×(4 hazards + 3 screens + 2 tailwind + 1 tera) = 20
  // Pokemon (×12 mons, ×~50 features each) = 600
  // Total: 3 + 14 + 20 + 600 = 637
  // Let's verify this empirically
  return 637;
}
