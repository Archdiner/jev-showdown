import { Dex } from '@pkmn/sim';

// Test known matchups
console.log('Testing type chart interpretation:\n');

// Fire vs Grass should be 2x (super-effective)
const grass = Dex.types.get('Grass');
console.log('Grass type damageTaken:');
console.log('  Fire:', grass.damageTaken['Fire'], '(Fire should be SE against Grass)');
console.log('  Water:', grass.damageTaken['Water'], '(Water should be NVE against Grass)');
console.log('  Grass:', grass.damageTaken['Grass'], '(Grass should be NVE against Grass)');

// Water vs Fire should be 2x (super-effective)
const fire = Dex.types.get('Fire');
console.log('\nFire type damageTaken:');
console.log('  Water:', fire.damageTaken['Water'], '(Water should be SE against Fire)');
console.log('  Fire:', fire.damageTaken['Fire'], '(Fire should be NVE against Fire)');
console.log('  Grass:', fire.damageTaken['Grass'], '(Grass should be NVE against Fire)');

// Ground type - should be weak to Water, Grass, Ice
const ground = Dex.types.get('Ground');
console.log('\nGround type damageTaken:');
console.log('  Water:', ground.damageTaken['Water'], '(Water should be SE against Ground)');
console.log('  Grass:', ground.damageTaken['Grass'], '(Grass should be SE against Ground)');
console.log('  Ice:', ground.damageTaken['Ice'], '(Ice should be SE against Ground)');
console.log('  Electric:', ground.damageTaken['Electric'], '(Ground should be immune to Electric)');

// Dragon type
const dragon = Dex.types.get('Dragon');
console.log('\nDragon type damageTaken:');
console.log('  Ice:', dragon.damageTaken['Ice'], '(Ice should be SE against Dragon)');
console.log('  Dragon:', dragon.damageTaken['Dragon'], '(Dragon should be SE against Dragon)');
console.log('  Fairy:', dragon.damageTaken['Fairy'], '(Fairy should be SE against Dragon)');
console.log('  Water:', dragon.damageTaken['Water'], '(Water should be NVE against Dragon)');
console.log('  Grass:', dragon.damageTaken['Grass'], '(Grass should be NVE against Dragon)');
console.log('  Electric:', dragon.damageTaken['Electric'], '(Electric should be NVE against Dragon)');

console.log('\n\nInterpretation:');
console.log('If value 1 appears for SE moves and 2 for NVE moves:');
console.log('  1 = Super Effective, 2 = Not Very Effective, 3 = Immune, 0 = Normal');
console.log('If value 2 appears for SE moves and 1 for NVE moves:');
console.log('  2 = Super Effective, 1 = Not Very Effective, 3 = Immune, 0 = Normal');
