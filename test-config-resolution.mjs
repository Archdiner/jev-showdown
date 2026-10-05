import { specFromId } from './dist/engine/exact/policies.js';

console.log('Testing config resolution...\n');

// Test exact-1ply-qw
const qwSpec = specFromId('EXACT_1PLY_QW');
console.log('exact-1ply-qw (EXACT_1PLY_QW):');
console.log(JSON.stringify(qwSpec, null, 2));
console.log('Has tera:', qwSpec.kind === 'exact' && qwSpec.config.tera === true);
console.log('Has progress:', qwSpec.kind === 'exact' && qwSpec.config.progress === true);
console.log('Has foePrior:', qwSpec.kind === 'exact' && qwSpec.config.foePrior === true);
console.log('samples:', qwSpec.kind === 'exact' ? qwSpec.config.samples : 'N/A');
console.log('');

// Test exact-1ply-qw-nash
const nashSpec = specFromId('exact-1ply-qw-nash');
console.log('exact-1ply-qw-nash:');
console.log(JSON.stringify(nashSpec, null, 2));
console.log('Has tera:', nashSpec.kind === 'exact' && nashSpec.config.tera === true);
console.log('Has progress:', nashSpec.kind === 'exact' && nashSpec.config.progress === true);
console.log('Has foePrior:', nashSpec.kind === 'exact' && nashSpec.config.foePrior === true);
console.log('Has solver:', nashSpec.kind === 'exact' && nashSpec.config.solver);
console.log('samples:', nashSpec.kind === 'exact' ? nashSpec.config.samples : 'N/A');
console.log('');

// Verify nash config
if (nashSpec.kind === 'exact') {
  const issues = [];
  if (!nashSpec.config.tera) issues.push('missing tera');
  if (!nashSpec.config.progress) issues.push('missing progress');
  if (!nashSpec.config.foePrior) issues.push('missing foePrior');
  if (!nashSpec.config.solver || nashSpec.config.solver === 'none') issues.push('missing solver');
  if (nashSpec.config.samples !== 8) issues.push(`samples=${nashSpec.config.samples}, expected 8`);
  
  if (issues.length > 0) {
    console.error('❌ FAILED: exact-1ply-qw-nash config has issues:', issues.join(', '));
    process.exit(1);
  } else {
    console.log('✅ PASSED: exact-1ply-qw-nash resolves correctly with qw flags + solver');
  }
} else {
  console.error('❌ FAILED: exact-1ply-qw-nash did not resolve to exact config');
  process.exit(1);
}
