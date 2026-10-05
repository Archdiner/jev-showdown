import { z } from 'zod';

// Node Types
export const NodeType = z.enum([
  'Goal',
  'Milestone', 
  'Task',
  'Experiment',
  'Hypothesis',
  'Result',
  'Decision',
  'Learning',
  'DataSource',
  'Convention',
  'Benchmark',
  'Champion',
  'Regression',
]);

export const NodeStatus = z.enum([
  'open',
  'in_progress',
  'blocked',
  'done',
  'rejected',
  'active', // for champions
  'superseded',
  'detected', // for regressions
]);

export const EdgeType = z.enum([
  'depends_on',
  'tests',
  'produced',
  'supersedes',
  'refutes',
  'supports',
  'blocks',
  'derived_from',
  'caused',         // experiment/commit caused regression
  'regressed_from', // regression from previous champion
]);

// Base node schema
export const BaseNode = z.object({
  id: z.string(),
  type: NodeType,
  status: NodeStatus,
  title: z.string(),
  description: z.string().optional(),
  owner: z.string().optional(),
  session: z.string().optional(),
  commit: z.string().optional(),
  created_at: z.number(),
  updated_at: z.number(),
  metrics: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type BaseNodeType = z.infer<typeof BaseNode>;

// Specific node schemas
export const GoalNode = BaseNode.extend({
  type: z.literal('Goal'),
  target_metric: z.string().optional(),
  target_value: z.number().optional(),
});

export const TaskNode = BaseNode.extend({
  type: z.literal('Task'),
  acceptance_criteria: z.array(z.string()).optional(),
  files: z.array(z.string()).optional(),
});

export const ExperimentNode = BaseNode.extend({
  type: z.literal('Experiment'),
  config_path: z.string().optional(),
  parent_experiment: z.string().optional(),
  hypothesis_id: z.string().optional(), // Must link to Hypothesis before coding
  predicted_effect: z.string().optional(),
  kill_condition: z.string().optional(),
});

export const HypothesisNode = BaseNode.extend({
  type: z.literal('Hypothesis'),
  rationale: z.string(),
  expected_effect: z.string(),
  test_plan: z.string(),
});

export const ResultNode = BaseNode.extend({
  type: z.literal('Result'),
  win_rate: z.number().optional(),
  game_count: z.number().optional(),
  fallback_rate: z.number().optional(),
  avg_latency_ms: z.number().optional(),
  confidence_interval: z.tuple([z.number(), z.number()]).optional(),
  elo: z.number().optional(),
});

export const DecisionNode = BaseNode.extend({
  type: z.literal('Decision'),
  context: z.string(),
  decision: z.string(),
  alternatives: z.array(z.string()).optional(),
  consequences: z.string().optional(),
});

export const LearningNode = BaseNode.extend({
  type: z.literal('Learning'),
  insight: z.string(),
  evidence: z.string().optional(),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
});

export const DataSourceNode = BaseNode.extend({
  type: z.literal('DataSource'),
  url: z.string(),
  refresh_cadence: z.string().optional(),
  reliability: z.enum(['trusted', 'derived', 'untrusted']).optional(),
});

export const ConventionNode = BaseNode.extend({
  type: z.literal('Convention'),
  category: z.enum(['code_style', 'module_boundary', 'testing', 'benchmark', 'other']).optional(),
  rationale: z.string().optional(),
});

export const BenchmarkNode = BaseNode.extend({
  type: z.literal('Benchmark'),
  opponent: z.string(),
  games: z.number(),
  result: z.string().optional(),
});

export const ChampionNode = BaseNode.extend({
  type: z.literal('Champion'),
  version: z.string(),
  config_path: z.string(),
  promoted_at: z.number(),
  elo_vs_panel: z.record(z.number()).optional(), // opponent_id -> elo
  metrics: z.object({
    // Core metrics
    win_rate_vs_random: z.number().optional(),
    win_rate_vs_maxdamage: z.number().optional(),
    win_rate_vs_champion: z.number().optional(),
    elo_vs_random: z.number().optional(),
    elo_vs_maxdamage: z.number().optional(),
    
    // Hard guardrails (must never regress)
    invalid_choices: z.number().optional(),
    crashes: z.number().optional(),
    timeouts: z.number().optional(),
    p99_turn_time_ms: z.number().optional(),
    fallback_rate: z.number().optional(),
    state_mismatches: z.number().optional(),
    
    // Diagnostics
    blunder_rate: z.number().optional(), // eval swings >200
    avg_eval_error: z.number().optional(),
    move_agreement_vs_high_elo: z.number().optional(),
  }).optional(),
});

// Gate result schema
export const GateResult = z.object({
  challenger_id: z.string(),
  champion_id: z.string(),
  verdict: z.enum(['promoted', 'rejected']),
  reason: z.string(),
  timestamp: z.number(),
  games_played: z.number(),
  
  // Statistical test results
  sprt_result: z.object({
    elo0: z.number(),
    elo1: z.number(),
    alpha: z.number(),
    beta: z.number(),
    llr: z.number(), // log likelihood ratio
    decision: z.enum(['accept_h1', 'accept_h0', 'continue']),
  }).optional(),
  
  // Per-opponent results
  panel_results: z.array(z.object({
    opponent: z.string(),
    challenger_elo: z.number(),
    champion_elo: z.number(),
    elo_diff: z.number(),
    win_rate: z.number(),
    ci_lower: z.number(), // Wilson CI
    ci_upper: z.number(),
    games: z.number(),
    significant_improvement: z.boolean(),
    significant_regression: z.boolean(),
  })),
  
  // Hard guardrails check
  guardrails: z.object({
    passed: z.boolean(),
    invalid_choices: z.number(),
    crashes: z.number(),
    timeouts: z.number(),
    p99_turn_time_ms: z.number(),
    fallback_rate: z.number(),
    state_mismatches: z.number(),
  }),
});

// Union type for all nodes
export const Node = z.discriminatedUnion('type', [
  GoalNode,
  BaseNode.extend({ type: z.literal('Milestone') }),
  TaskNode,
  ExperimentNode,
  HypothesisNode,
  ResultNode,
  DecisionNode,
  LearningNode,
  DataSourceNode,
  ConventionNode,
  BenchmarkNode,
  ChampionNode,
]);

export type NodeData = z.infer<typeof Node>;

// Edge schema
export const Edge = z.object({
  id: z.string(),
  from_node: z.string(),
  to_node: z.string(),
  type: EdgeType,
  created_at: z.number(),
  metadata: z.record(z.unknown()).optional(),
});

export type EdgeData = z.infer<typeof Edge>;

// Graph export schema
export const Graph = z.object({
  version: z.literal('1.0'),
  exported_at: z.number(),
  nodes: z.array(Node),
  edges: z.array(Edge),
});

export type GraphData = z.infer<typeof Graph>;
