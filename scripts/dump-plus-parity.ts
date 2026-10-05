// Dump the champion / stacked-qw-fitted decision traces for src/config/plus-parity.test.ts.
// usage: npx tsx scripts/dump-plus-parity.ts <out.json>
import { writeFileSync } from 'fs';
import { collectPlusParity } from '../src/config/plus-parity.js';
const out = process.argv[2];
const t = Date.now();
const games = await collectPlusParity();
writeFileSync(out, JSON.stringify(games, null, 1) + '\n');
console.log('games', games.length, games.map(g => `${g.seed} ${g.p1}-${g.p2} ${g.winner} t${g.turns} n${g.choices.length}`), Date.now() - t, 'ms');
