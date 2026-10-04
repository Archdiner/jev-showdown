#!/usr/bin/env node

import { Gate } from './gate.js';
import { GraphDB } from './db.js';

const args = process.argv.slice(2);

if (args.length < 2) {
  console.log('Usage: gate <challenger-id> <champion-id>');
  console.log('Runs gate tournament and records verdict to graph');
  process.exit(1);
}

const [challengerId, championId] = args;

const db = new GraphDB();
const gate = new Gate(db);

(async () => {
  try {
    const result = await gate.runTournament(challengerId, championId);
    
    console.log('\n' + '='.repeat(60));
    console.log(`FINAL VERDICT: ${result.verdict.toUpperCase()}`);
    console.log(`Reason: ${result.reason}`);
    console.log('='.repeat(60));
    console.log('\nResult recorded to graph. Run `npm run graph -- status` to see updated state.');
    
    process.exit(result.verdict === 'promoted' ? 0 : 1);
  } catch (e) {
    console.error('Gate error:', e);
    process.exit(1);
  } finally {
    db.close();
  }
})();
