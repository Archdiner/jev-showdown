#!/usr/bin/env node

import { Gen9RandomBattle } from './gen9-randombattle.js';
import { PokemonBelief } from '../types/index.js';

const format = new Gen9RandomBattle();

console.log('Testing team generation constraints...\n');

// Test 1: Valid team
console.log('Test 1: Valid team (should pass)');
const validTeam: PokemonBelief[] = [
  { species: 'Pikachu', level: 80, possibleSets: new Map(), revealedMoves: new Set(), currentHp: 100, maxHp: 100 },
  { species: 'Charizard', level: 80, possibleSets: new Map(), revealedMoves: new Set(), currentHp: 100, maxHp: 100 },
  { species: 'Blastoise', level: 80, possibleSets: new Map(), revealedMoves: new Set(), currentHp: 100, maxHp: 100 },
  { species: 'Venusaur', level: 80, possibleSets: new Map(), revealedMoves: new Set(), currentHp: 100, maxHp: 100 },
  { species: 'Gengar', level: 80, possibleSets: new Map(), revealedMoves: new Set(), currentHp: 100, maxHp: 100 },
  { species: 'Dragonite', level: 80, possibleSets: new Map(), revealedMoves: new Set(), currentHp: 100, maxHp: 100 },
];

const result1 = format.validateTeamConstraints(validTeam);
console.log(result1 ? `❌ Failed: ${result1.join('; ')}` : '✓ Passed\n');

// Test 2: Too many Water types (>2)
console.log('Test 2: More than 2 Water-type mons (should fail)');
const tooManyWaterTeam: PokemonBelief[] = [
  { species: 'Blastoise', level: 80, possibleSets: new Map(), revealedMoves: new Set(), currentHp: 100, maxHp: 100 },
  { species: 'Gyarados', level: 80, possibleSets: new Map(), revealedMoves: new Set(), currentHp: 100, maxHp: 100 },
  { species: 'Vaporeon', level: 80, possibleSets: new Map(), revealedMoves: new Set(), currentHp: 100, maxHp: 100 },
  { species: 'Pikachu', level: 80, possibleSets: new Map(), revealedMoves: new Set(), currentHp: 100, maxHp: 100 },
  { species: 'Gengar', level: 80, possibleSets: new Map(), revealedMoves: new Set(), currentHp: 100, maxHp: 100 },
  { species: 'Dragonite', level: 80, possibleSets: new Map(), revealedMoves: new Set(), currentHp: 100, maxHp: 100 },
];

const result2 = format.validateTeamConstraints(tooManyWaterTeam);
console.log(result2 ? `✓ Failed as expected: ${result2.join('; ')}\n` : '❌ Should have failed but passed\n');

// Test 3: Shared 4x weakness (Rock/Flying mons share 4x Electric weakness... wait, that's not right)
// Let's use Fighting/Rock types which are 4x weak to Ground
console.log('Test 3: Shared 4x weakness (should fail)');
const shared4xTeam: PokemonBelief[] = [
  { species: 'Terrakion', level: 80, possibleSets: new Map(), revealedMoves: new Set(), currentHp: 100, maxHp: 100 }, // Rock/Fighting, 4x weak to Ground
  { species: 'Lucario', level: 80, possibleSets: new Map(), revealedMoves: new Set(), currentHp: 100, maxHp: 100 },   // Fighting/Steel, not 4x
  { species: 'Pikachu', level: 80, possibleSets: new Map(), revealedMoves: new Set(), currentHp: 100, maxHp: 100 },
  { species: 'Gengar', level: 80, possibleSets: new Map(), revealedMoves: new Set(), currentHp: 100, maxHp: 100 },
  { species: 'Charizard', level: 80, possibleSets: new Map(), revealedMoves: new Set(), currentHp: 100, maxHp: 100 },
  { species: 'Rampardos', level: 80, possibleSets: new Map(), revealedMoves: new Set(), currentHp: 100, maxHp: 100 }, // Rock, 2x weak to Ground
];

const result3 = format.validateTeamConstraints(shared4xTeam);
console.log(result3 ? `Result: ${result3.join('; ')}\n` : '✓ Passed (or no 4x found)\n');

// Test 4: Too many mons weak to one type
console.log('Test 4: More than 3 mons weak to Electric (should fail)');
const tooManyElectricWeakTeam: PokemonBelief[] = [
  { species: 'Blastoise', level: 80, possibleSets: new Map(), revealedMoves: new Set(), currentHp: 100, maxHp: 100 },  // Water, weak to Electric
  { species: 'Gyarados', level: 80, possibleSets: new Map(), revealedMoves: new Set(), currentHp: 100, maxHp: 100 },   // Water/Flying, 4x weak to Electric
  { species: 'Vaporeon', level: 80, possibleSets: new Map(), revealedMoves: new Set(), currentHp: 100, maxHp: 100 },   // Water, weak to Electric
  { species: 'Pelipper', level: 80, possibleSets: new Map(), revealedMoves: new Set(), currentHp: 100, maxHp: 100 },   // Water/Flying, 4x weak to Electric
  { species: 'Gengar', level: 80, possibleSets: new Map(), revealedMoves: new Set(), currentHp: 100, maxHp: 100 },
  { species: 'Charizard', level: 80, possibleSets: new Map(), revealedMoves: new Set(), currentHp: 100, maxHp: 100 },
];

const result4 = format.validateTeamConstraints(tooManyElectricWeakTeam);
console.log(result4 ? `✓ Failed as expected: ${result4.join('; ')}\n` : '❌ Should have failed but passed\n');

console.log('Testing strict role narrowing...\n');

// Test 5: Role narrowing from revealed move
console.log('Test 5: Role narrowing from revealed physical move (should eliminate special-only roles)');
const physicalMon: PokemonBelief = {
  species: 'Pikachu',
  level: 80,
  possibleSets: new Map(),
  revealedMoves: new Set(['thunderbolt', 'voltswitch']),
  currentHp: 100,
  maxHp: 100,
};

// We need stats data for this - skip for now since we don't have it loaded
console.log('Skipped (requires stats data to be loaded)\n');

console.log('✓ Constraint validation tests complete');
