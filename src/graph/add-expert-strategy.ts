#!/usr/bin/env node

import { GraphDB } from './db.js';

const db = new GraphDB();
const now = Date.now();

console.log('Adding expert strategy to graph...\n');

// Add Learning nodes (source: expert, top-5 ladder, circuit grand finalist)
const learnings = [
  {
    id: 'learning-set-info-narrowing',
    title: 'Strict role narrowing from reveals',
    insight: 'Enumerate opponent possible roles and narrow strictly from revealed moves, ability, item, Tera. Roles exclude certain moves/items (match Showdex set tab).',
    evidence: 'Expert: top-5 ladder, circuit grand finalist',
    confidence: 'high' as const,
  },
  {
    id: 'learning-hazards-huge',
    title: 'Hazards are huge in randbats',
    insight: 'Boots and removal are rare. Toxic Spikes wins games vs teams with few Poison types. Get setter in safely, never risk it. Don\'t set rocks while threat sets up. Don\'t sacrifice team for useless layers. If opponent has hazards and we don\'t, play faster.',
    evidence: 'Expert: hazards dominate due to rare removal',
    confidence: 'high' as const,
  },
  {
    id: 'learning-preserve-resources',
    title: 'Preserve resources and information advantage',
    insight: 'No team preview means info is advantage. Don\'t throw mons away to unknown threats. Don\'t speedrun unless matchup good or opponent hazards force it. Use Tera second. Exception: sacrificing slow, low-HP hazard setter for momentum is fine.',
    evidence: 'Expert: resource preservation wins games',
    confidence: 'high' as const,
  },
  {
    id: 'learning-speed-option',
    title: 'Identify and preserve speed option',
    insight: 'Keep fastest mon, priority, Choice Scarf, or speed booster healthy and hidden. Endgames are chip-heavy. Use wallbreakers early.',
    evidence: 'Expert: speed control critical in endgame',
    confidence: 'high' as const,
  },
  {
    id: 'learning-team-gen-rules',
    title: 'Team-generation rules are information',
    insight: 'Constraints: max 2 mons per type, max 3 weak to one type, no shared 4x weakness, only 1 Tera Blast role per team (Gen 9).',
    evidence: 'Expert + verifiable in data/random-battles/gen9/teams.ts',
    confidence: 'high' as const,
  },
];

learnings.forEach(l => {
  db.addNode({
    id: l.id,
    type: 'Learning',
    status: 'active',
    title: l.title,
    description: l.insight,
    created_at: now,
    updated_at: now,
    insight: l.insight,
    evidence: l.evidence,
    confidence: l.confidence,
    metadata: {
      source: 'expert',
      expert_credentials: 'top-5 ladder, circuit grand finalist',
    },
  } as any);
  
  // Link to main goal
  db.addEdge({
    id: `${l.id}-supports-goal-ladder-1`,
    from_node: l.id,
    to_node: 'goal-ladder-1',
    type: 'supports',
    created_at: now,
  });
  
  console.log(`✓ Added learning: ${l.title}`);
});

console.log('\nAdding hypothesis nodes...\n');

// Add Hypothesis nodes (testable improvements)
const hypotheses = [
  {
    id: 'hyp-hazard-differential',
    title: 'Hazard differential weighted by boots/removal',
    rationale: 'Expert says hazards dominate randbats due to rare boots/removal. Should weight hazard advantage higher than current eval.',
    expected_effect: '+3-5% win rate by valuing hazard advantage appropriately',
    test_plan: 'Weight hazards by: (a) count boots on our team, (b) count removal on our team, (c) same for opponent belief, (d) increase hazard value by 2-3x if opponent lacks boots/removal',
    metadata: {
      kill_condition: 'No improvement after 200 games, or regression vs any panel member',
      derived_from: 'learning-hazards-huge',
      files: ['src/engine/evaluator.ts'],
    },
  },
  {
    id: 'hyp-protect-hazard-setter',
    title: 'Protect hazard setter (never risk it)',
    rationale: 'Expert: get setter in safely, never risk it. Current eval doesn\'t distinguish setter from other mons.',
    expected_effect: '+2-4% win rate by preserving setter and getting hazards up consistently',
    test_plan: 'Tag hazard setters in belief. Add penalty (-300) if setter at risk (low HP, bad matchup). Add bonus (+200) if setter switched in safely. Don\'t sacrifice setter unless slow + low HP.',
    metadata: {
      kill_condition: 'No improvement after 200 games',
      derived_from: 'learning-hazards-huge',
      files: ['src/engine/evaluator.ts', 'src/types/index.ts'],
    },
  },
  {
    id: 'hyp-resource-preservation',
    title: 'Resource preservation (don\'t throw mons away)',
    rationale: 'Expert: don\'t throw mons to unknown threats. No team preview means info is advantage.',
    expected_effect: '+2-3% win rate by avoiding bad sacrifices',
    test_plan: 'Penalize moves that risk KO when opponent has 4+ unknown mons. Add info value: bonus for knowing opponent team, penalty for letting ours die before seeing theirs. Track "deaths to unknown threats" metric.',
    metadata: {
      kill_condition: 'No improvement after 200 games, or increases avg game length >20%',
      derived_from: 'learning-preserve-resources',
      files: ['src/engine/evaluator.ts'],
    },
  },
  {
    id: 'hyp-tera-second',
    title: 'Tera-second prior (opponent Teras first)',
    rationale: 'Expert: use Tera second. Preserves our options and forces opponent to commit first.',
    expected_effect: '+1-2% win rate by waiting for opponent Tera',
    test_plan: 'Add Tera timing heuristic: if opponent hasn\'t Tera\'d and we haven\'t, penalize our Tera moves (-150). Once opponent Teras, remove penalty.',
    metadata: {
      kill_condition: 'No improvement after 200 games',
      derived_from: 'learning-preserve-resources',
      files: ['src/engine/evaluator.ts'],
    },
  },
  {
    id: 'hyp-speed-option-preservation',
    title: 'Speed option preservation',
    rationale: 'Expert: identify and preserve fastest mon / priority / Scarf. Endgames are chip-heavy.',
    expected_effect: '+2-4% win rate by keeping speed control for endgame',
    test_plan: 'Identify speed option (fastest, priority moves, Choice Scarf, speed booster). Add bonus (+150) if healthy. Add penalty (-200) if at risk of fainting. Track "speed option survived to endgame" metric.',
    metadata: {
      kill_condition: 'No improvement after 200 games',
      derived_from: 'learning-speed-option',
      files: ['src/engine/evaluator.ts', 'src/types/index.ts'],
    },
  },
  {
    id: 'hyp-tempo-switch-hazard-disadvantage',
    title: 'Play faster when opponent has hazard advantage',
    rationale: 'Expert: if opponent has hazards and we don\'t, play faster. Don\'t switch as much.',
    expected_effect: '+1-2% win rate by adapting tempo to hazard state',
    test_plan: 'Add tempo adjustment: if opponent has hazards and we don\'t, reduce switch penalty and increase attack bonus. Measure "avg turns per game" and "switch rate" vs hazard differential.',
    metadata: {
      kill_condition: 'No improvement after 200 games',
      derived_from: 'learning-hazards-huge',
      files: ['src/engine/evaluator.ts'],
    },
  },
];

hypotheses.forEach(h => {
  db.addNode({
    id: h.id,
    type: 'Hypothesis',
    status: 'open',
    title: h.title,
    description: h.rationale,
    created_at: now,
    updated_at: now,
    rationale: h.rationale,
    expected_effect: h.expected_effect,
    test_plan: h.test_plan,
    metadata: h.metadata,
  } as any);
  
  // Link hypothesis to learning it was derived from
  const derivedFrom = (h.metadata as any).derived_from;
  db.addEdge({
    id: `${h.id}-derived-from-${derivedFrom}`,
    from_node: h.id,
    to_node: derivedFrom,
    type: 'derived_from',
    created_at: now,
  });
  
  console.log(`✓ Added hypothesis: ${h.title}`);
});

console.log('\nAdding correctness tasks (immediate implementation)...\n');

// Add tasks for correctness fixes (not experiments - these are pure improvements)
const correctnessTasks = [
  {
    id: 'task-team-gen-constraints',
    title: 'Implement team-generation constraints',
    description: 'Verify and enforce: max 2 mons per type, max 3 weak to one type, no shared 4x weakness, only 1 Tera Blast per team',
    acceptance_criteria: [
      'Verify constraints in data/random-battles/gen9/teams.ts',
      'Implement in opponent world sampler (Format.sampleOpponentSet)',
      'Test: sample 1000 opponent teams, all satisfy constraints',
      'Document any discrepancies found',
    ],
    files: ['src/formats/gen9-randombattle.ts', 'src/engine/world-builder.ts'],
  },
  {
    id: 'task-strict-role-narrowing',
    title: 'Implement strict role narrowing from reveals',
    description: 'Narrow opponent set possibilities strictly: each role excludes certain moves/items. Match Showdex behavior.',
    acceptance_criteria: [
      'Parse role definitions from sets.json (each role has specific moves/items)',
      'When move/item/ability revealed, eliminate incompatible roles',
      'Test: if Earthquake revealed, eliminate special-only roles',
      'Verify: belief entropy decreases monotonically with reveals',
    ],
    files: ['src/formats/gen9-randombattle.ts', 'src/engine/belief-tracker.ts'],
  },
];

correctnessTasks.forEach(t => {
  db.addNode({
    id: t.id,
    type: 'Task',
    status: 'open',
    title: t.title,
    description: t.description,
    created_at: now,
    updated_at: now,
    acceptance_criteria: t.acceptance_criteria,
    files: t.files,
    metadata: {
      priority: 'high',
      category: 'correctness',
    },
  } as any);
  
  // Link to relevant learning
  if (t.id.includes('team-gen')) {
    db.addEdge({
      id: `${t.id}-tests-learning-team-gen-rules`,
      from_node: t.id,
      to_node: 'learning-team-gen-rules',
      type: 'tests',
      created_at: now,
    });
  } else if (t.id.includes('role-narrowing')) {
    db.addEdge({
      id: `${t.id}-tests-learning-set-info-narrowing`,
      from_node: t.id,
      to_node: 'learning-set-info-narrowing',
      type: 'tests',
      created_at: now,
    });
  }
  
  console.log(`✓ Added task: ${t.title}`);
});

console.log('\n✓ Expert strategy encoded in graph');
console.log('Run `npm run graph -- status` to see updated frontier');
console.log('Run `npm run graph -- query by-type Hypothesis` to list all hypotheses\n');

db.close();
