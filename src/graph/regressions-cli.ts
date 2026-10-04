#!/usr/bin/env node

import { GraphDB } from './db.js';
import { RegressionTracker } from './regression-tracker.js';

const db = new GraphDB();
const tracker = new RegressionTracker(db);

console.log('=== Detected Regressions ===\n');

const regressions = tracker.getAllRegressions();

if (regressions.length === 0) {
  console.log('✓ No regressions detected\n');
  db.close();
  process.exit(0);
}

// Group by severity
const bySeverity = {
  critical: regressions.filter((r: any) => r.metrics?.severity === 'critical'),
  major: regressions.filter((r: any) => r.metrics?.severity === 'major'),
  minor: regressions.filter((r: any) => r.metrics?.severity === 'minor'),
};

console.log(`Total: ${regressions.length} regressions\n`);
console.log(`  Critical: ${bySeverity.critical.length}`);
console.log(`  Major: ${bySeverity.major.length}`);
console.log(`  Minor: ${bySeverity.minor.length}\n`);

// Show each regression
for (const severity of ['critical', 'major', 'minor'] as const) {
  const items = bySeverity[severity];
  if (items.length === 0) continue;
  
  console.log(`\n${severity.toUpperCase()} Regressions (${items.length}):`);
  console.log('─'.repeat(80));
  
  for (const reg of items) {
    const metrics = reg.metrics || {};
    const metricPath = metrics.metric_path || 'unknown';
    const baseline = metrics.baseline_value || 0;
    const candidate = metrics.candidate_value || 0;
    const delta = metrics.delta || 0;
    const deltaPercent = (delta * 100).toFixed(1);
    
    console.log(`\n  ${metricPath}`);
    console.log(`    Baseline:  ${baseline.toFixed(3)}`);
    console.log(`    Candidate: ${candidate.toFixed(3)}`);
    console.log(`    Delta:     ${delta.toFixed(3)} (${deltaPercent}%)`);
    
    if (metrics.ci_lower !== undefined && metrics.ci_upper !== undefined) {
      console.log(`    95% CI:    [${metrics.ci_lower.toFixed(3)}, ${metrics.ci_upper.toFixed(3)}]`);
    }
    
    if (reg.metadata?.commit_sha) {
      console.log(`    Commit:    ${reg.metadata.commit_sha.substring(0, 8)}`);
    }
    
    console.log(`    ID:        ${reg.id}`);
  }
}

console.log('\n');

db.close();
