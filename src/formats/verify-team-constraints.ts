#!/usr/bin/env node

import { Dex, Teams } from '@pkmn/sim';
import { TeamGenerators } from '@pkmn/randoms';
import { Gen9RandomBattle } from './gen9-randombattle.js';
import { PokemonBelief } from '../types/index.js';

const format = new Gen9RandomBattle();
Teams.setGeneratorFactory(TeamGenerators);

console.log('Verifying team generation constraints against @pkmn/randoms...\n');
console.log('Generating 100 random teams and checking constraints:\n');

const violations: string[][] = [];
let validTeams = 0;

for (let i = 0; i < 100; i++) {
  try {
    const generator = Teams.getGenerator('gen9randombattle' as any);
    const team = generator.getTeam();
    
    // Convert to our belief format
    const beliefs: PokemonBelief[] = team.map(mon => {
      const species = typeof mon.species === 'string' ? mon.species : mon.species?.name || 'Unknown';
      return {
        species,
        level: mon.level || 80,
        possibleSets: new Map(),
        revealedMoves: new Set(mon.moves || []),
        revealedAbility: mon.ability,
        revealedItem: mon.item,
        currentHp: 100,
        maxHp: 100,
      };
    });
    
    const result = format.validateTeamConstraints(beliefs);
    
    if (result === null) {
      validTeams++;
    } else {
      violations.push(result);
      if (violations.length <= 5) {
        console.log(`Team ${i + 1} violations:`);
        result.forEach(v => console.log(`  - ${v}`));
        console.log(`  Team: ${beliefs.map(b => b.species).join(', ')}\n`);
      }
    }
  } catch (e) {
    console.error(`Error generating team ${i + 1}:`, e);
  }
}

console.log('\n=== Summary ===');
console.log(`Valid teams: ${validTeams}/100`);
console.log(`Teams with violations: ${violations.length}/100`);

if (violations.length > 0) {
  console.log(`\nViolation types:`);
  const violationTypes: Record<string, number> = {};
  violations.flat().forEach(v => {
    const type = v.split('(')[0].trim();
    violationTypes[type] = (violationTypes[type] || 0) + 1;
  });
  
  Object.entries(violationTypes)
    .sort((a, b) => b[1] - a[1])
    .forEach(([type, count]) => {
      console.log(`  ${type}: ${count} occurrences`);
    });
}

// Test strict role narrowing
console.log('\n\n=== Testing strict role narrowing ===\n');

// We need to load stats data for this
import { dataLoader } from '../data/data-loader.js';

await dataLoader.load(format);

console.log('Testing role narrowing for Pikachu...');
const pikachu: PokemonBelief = {
  species: 'Pikachu',
  level: 80,
  possibleSets: new Map(),
  revealedMoves: new Set(),
  currentHp: 100,
  maxHp: 100,
};

let candidates = format.getPossibleSets(pikachu);
console.log(`Before reveals: ${candidates.length} possible roles`);
candidates.forEach(c => console.log(`  - ${c.role} (${(c.probability * 100).toFixed(1)}%)`));

// Reveal a physical move
pikachu.revealedMoves.add('voltswitch');
candidates = format.getPossibleSets(pikachu);
console.log(`\nAfter revealing Volt Switch: ${candidates.length} possible roles`);
candidates.forEach(c => console.log(`  - ${c.role} (${(c.probability * 100).toFixed(1)}%)`));

// Reveal item
pikachu.revealedItem = 'Light Ball';
candidates = format.getPossibleSets(pikachu);
console.log(`\nAfter revealing Light Ball: ${candidates.length} possible roles`);
candidates.forEach(c => console.log(`  - ${c.role} (${(c.probability * 100).toFixed(1)}%)`));

console.log('\n✓ Role narrowing verification complete');
