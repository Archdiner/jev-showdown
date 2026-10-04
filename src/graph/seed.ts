#!/usr/bin/env node

import { GraphDB } from './db.js';
import { execSync } from 'child_process';

const db = new GraphDB();
const now = Date.now();
const currentCommit = execSync('git rev-parse HEAD').toString().trim().slice(0, 7);

console.log('Seeding graph with initial state...\n');

// Add the main goal
db.addNode({
  id: 'goal-ladder-1',
  type: 'Goal',
  status: 'open',
  title: '#1 on gen9randombattle ladder',
  description: 'Achieve top ranking through exact mechanics and strategic play',
  created_at: now,
  updated_at: now,
  metadata: {
    target_metric: 'ladder_elo',
    target_value: 1900, // approximate #1 threshold
  },
} as any);

// Add current champion (v0 - exact sim integration)
db.addNode({
  id: 'champion-v0',
  type: 'Champion',
  status: 'active',
  title: 'Champion v0: Exact Sim',
  description: '3-ply expectiminimax with 0% fallback, exact @pkmn/sim mechanics',
  created_at: now,
  updated_at: now,
  commit: currentCommit,
  version: 'v0',
  config_path: 'src/bot/bot.ts', // default config
  promoted_at: now,
  metrics: {
    win_rate_vs_random: 1.0, // Quick test only (5 games)
    fallback_rate: 0.0,
    invalid_choices: 0,
    crashes: 0,
    timeouts: 0,
    p99_turn_time_ms: 1500,
    state_mismatches: 0,
  },
} as any);

// Add key decisions (ADRs)
const decisions = [
  {
    id: 'decision-typescript-pkmn',
    title: 'TypeScript with @pkmn ecosystem',
    context: 'Need accurate Pokemon mechanics. Options: build from scratch, unofficial sims, or @pkmn packages.',
    decision: 'Use TypeScript with @pkmn/sim, @pkmn/dex, @pkmn/randoms for all mechanics.',
    alternatives: ['Python + unofficial sim', 'Custom simulator', 'JavaScript without types'],
    consequences: 'Exact official mechanics, MIT licensed, tied to @pkmn update cycle',
  },
  {
    id: 'decision-mit-only',
    title: 'MIT-only licensing',
    context: 'Open source project needs clear licensing.',
    decision: 'All dependencies must be MIT, Apache-2.0, BSD, or equivalent. No GPL/AGPL.',
    alternatives: ['Allow GPL', 'Proprietary code'],
    consequences: 'Permissive reuse, excludes some ML libraries',
  },
  {
    id: 'decision-search-first',
    title: 'Search-first over LLM-first',
    context: 'Two approaches: LLM generates moves, or traditional search.',
    decision: 'Core uses game-tree search (expectiminimax). LLMs optional for priors only.',
    alternatives: ['LLM-only', 'Pure rule-based'],
    consequences: 'Explainable, fast, improves with eval not just data',
  },
  {
    id: 'decision-exact-sim',
    title: 'Exact sim in search, not fallback',
    context: 'Original had 100% fallback to hand-written damage calc.',
    decision: 'Fixed Battle creation to achieve 0% fallback. Search MUST use Battle.makeChoices().',
    alternatives: ['Accept fallback', 'Improve fallback approximation'],
    consequences: 'Accurate predictions, more complex code, must keep GameState synced',
  },
];

decisions.forEach((d, i) => {
  db.addNode({
    id: d.id,
    type: 'Decision',
    status: 'done',
    title: d.title,
    description: d.context,
    created_at: now - (1000 * 60 * 60 * (decisions.length - i)), // stagger timestamps
    updated_at: now,
    commit: currentCommit,
    context: d.context,
    decision: d.decision,
    alternatives: d.alternatives,
    consequences: d.consequences,
  } as any);
  
  // Link decision to goal
  db.addEdge({
    id: `${d.id}-supports-goal-ladder-1`,
    from_node: d.id,
    to_node: 'goal-ladder-1',
    type: 'supports',
    created_at: now,
  });
});

// Add key data sources
const sources = [
  {
    id: 'source-smogon-sets',
    title: 'Smogon Gen9 Random Battle Sets',
    url: 'https://raw.githubusercontent.com/smogon/pokemon-showdown/master/data/random-battles/gen9/sets.json',
    reliability: 'trusted',
    refresh_cadence: 'daily',
  },
  {
    id: 'source-pkmn-stats',
    title: 'pkmn Randbats Statistics',
    url: 'https://pkmn.github.io/randbats/data/gen9randombattle.json',
    reliability: 'trusted',
    refresh_cadence: 'weekly',
  },
];

sources.forEach(s => {
  db.addNode({
    id: s.id,
    type: 'DataSource',
    status: 'active',
    title: s.title,
    created_at: now,
    updated_at: now,
    url: s.url,
    reliability: s.reliability as any,
    refresh_cadence: s.refresh_cadence,
  } as any);
});

// Add immediate tasks
db.addNode({
  id: 'task-full-benchmark',
  type: 'Task',
  status: 'open',
  title: 'Run full benchmark with exact sim',
  description: 'Measure true win rates with 0% fallback (300+ games vs random and max-damage)',
  created_at: now,
  updated_at: now,
  acceptance_criteria: [
    '300+ games vs random',
    '300+ games vs max-damage',
    'Fallback rate stays 0.00%',
    'Record metrics in champion node',
  ],
  files: ['src/cli/selfplay.ts'],
} as any);

db.addEdge({
  id: 'task-full-benchmark-tests-champion-v0',
  from_node: 'task-full-benchmark',
  to_node: 'champion-v0',
  type: 'tests',
  created_at: now,
});

db.addNode({
  id: 'task-ladder-client',
  type: 'Task',
  status: 'open',
  title: 'Make ladder client production-ready',
  description: 'Live ladder games with reconnection, timer-safe moves, logging',
  created_at: now,
  updated_at: now,
  acceptance_criteria: [
    'Verify full games vs local showdown server',
    'npm run ladder --games N --format gen9randombattle',
    'Timer-safe submission with hard per-turn deadline',
    'Reconnect/resume on disconnect',
    'Log every game and decision to data store',
    'Tag source=ladder with opponent name/rating',
  ],
  files: ['src/client/showdown-client.ts', 'src/cli/ladder.ts'],
} as any);

console.log('✓ Added goal, champion v0, decisions, data sources, tasks');
console.log('\nRun `npm run graph -- status` to see the graph state');
console.log('Run `npm run graph -- next` to get the best next action\n');

db.close();
