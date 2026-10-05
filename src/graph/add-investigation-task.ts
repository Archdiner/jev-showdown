#!/usr/bin/env node

import { GraphDB } from './db.js';

const db = new GraphDB();
const now = Date.now();

console.log('Adding search investigation task...\n');

const task = {
  id: 'task-investigate-search-failure',
  type: 'Task' as const,
  status: 'in_progress' as const,
  title: 'Investigate catastrophic search failure (62.7% vs random)',
  description: '3-ply exact-sim search winning only 62.7% vs random (max-damage gets 84%) indicates fundamental bug. Suspects: eval sign flip, paranoid minimax vs stochastic opponent, terminal node scoring, world reconstruction, depth parity, time budget cutting search.',
  created_at: now,
  updated_at: now,
  acceptance_criteria: [
    'Champion >= 95% vs random over 300 paired games',
    '0 invalid choices (fix trapped-switch bug in getLegalActions)',
    'All diagnostic positions pick obvious best move',
    'Worst losses mined and root causes identified',
  ],
  priority: 'critical',
  files: [
    'src/engine/robust-search.ts',
    'src/engine/evaluator.ts',
    'src/formats/gen9-randombattle.ts',
    'src/engine/world-builder.ts',
  ],
  metadata: {
    baseline: '62.7% vs random (broken)',
    target: '>=95% vs random',
    max_damage_baseline: '84% vs random',
    problem: 'fundamental search or eval bug',
  },
};

db.addNode(task);

// Link to main goal
db.addEdge({
  id: 'task-investigate-search-failure-blocks-goal-ladder-1',
  from_node: 'task-investigate-search-failure',
  to_node: 'goal-ladder-1',
  type: 'blocks',
  created_at: now,
});

console.log('✓ Added task: Investigate search failure');
console.log('Status: IN_PROGRESS (top priority)');
console.log('Target: >=95% vs random, 0 invalid choices\n');

db.close();
