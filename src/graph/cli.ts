#!/usr/bin/env node

import { GraphDB } from './db.js';
import { NodeData, EdgeData, NodeType, NodeStatus, EdgeType } from './schema.js';
import * as fs from 'fs';
import * as path from 'path';

const db = new GraphDB();

function generateId(type: string, title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  return `${type.toLowerCase()}-${slug}-${Date.now().toString(36)}`;
}

function status(): void {
  console.log('=== Graph Status ===\n');

  // Get current champion
  const champions = db.getNodesByType('Champion', 'active');
  if (champions.length > 0) {
    const champ = champions[0] as any;
    const metrics = champ.metrics || {};
    const vsRandom = champ.win_rate_vs_random ?? metrics.win_rate_vs_random;
    const vsMax = champ.win_rate_vs_maxdamage ?? metrics.win_rate_vs_maxdamage;
    console.log(`Current Champion: ${champ.version}`);
    if (typeof vsRandom === 'number') {
      console.log(`  vs Random: ${(vsRandom * 100).toFixed(1)}%`);
    }
    if (typeof vsMax === 'number') {
      console.log(`  vs Max-Damage: ${(vsMax * 100).toFixed(1)}%`);
    }
    console.log('');
  }

  // Get frontier (unblocked high-value tasks)
  const frontier = db.getFrontier();
  console.log(`Frontier (${frontier.length} unblocked tasks):`);
  frontier.slice(0, 5).forEach((node, i) => {
    console.log(`  ${i + 1}. [${node.status}] ${node.title}`);
    if (node.description) {
      console.log(`     ${node.description.slice(0, 80)}...`);
    }
  });
  console.log('');

  // Count by type and status
  const types = ['Task', 'Experiment', 'Hypothesis', 'Result', 'Decision', 'Learning'];
  types.forEach(type => {
    const nodes = db.getNodesByType(type);
    if (nodes.length > 0) {
      const byStatus = nodes.reduce((acc, n) => {
        acc[n.status] = (acc[n.status] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      console.log(`${type}: ${nodes.length} (${Object.entries(byStatus).map(([s, c]) => `${s}:${c}`).join(', ')})`);
    }
  });
}

function next(): void {
  const frontier = db.getFrontier();
  
  if (frontier.length === 0) {
    console.log('No unblocked tasks. All tasks either done, blocked, or in progress.');
    return;
  }

  // Pick the highest priority: in_progress first, then open
  const inProgress = frontier.filter(n => n.status === 'in_progress');
  const best = inProgress.length > 0 ? inProgress[0] : frontier[0];

  console.log('=== Next Action ===\n');
  console.log(`ID: ${best.id}`);
  console.log(`Title: ${best.title}`);
  console.log(`Type: ${best.type}`);
  console.log(`Status: ${best.status}`);
  if (best.description) {
    console.log(`\nDescription:\n${best.description}`);
  }

  if (best.type === 'Task') {
    const task = best as any;
    if (task.acceptance_criteria && task.acceptance_criteria.length > 0) {
      console.log('\nAcceptance Criteria:');
      task.acceptance_criteria.forEach((c: string, i: number) => {
        console.log(`  ${i + 1}. ${c}`);
      });
    }
    if (task.files && task.files.length > 0) {
      console.log(`\nFiles: ${task.files.join(', ')}`);
    }
  }

  if (best.type === 'Hypothesis') {
    const hyp = best as any;
    console.log(`\nExpected Effect: ${hyp.expected_effect}`);
    console.log(`\nTest Plan:\n${hyp.test_plan}`);
  }

  // Check dependencies
  const deps = db.getEdgesFrom(best.id, 'depends_on');
  if (deps.length > 0) {
    console.log('\nDependencies:');
    deps.forEach(e => {
      const dep = db.getNode(e.to_node);
      if (dep) {
        console.log(`  - [${dep.status}] ${dep.title}`);
      }
    });
  }
}

function addNode(argv: string[]): void {
  // Usage: add <type> <title> [--description="..."] [--status=open] [--commit=abc] ...
  if (argv.length < 2) {
    console.error('Usage: add <type> <title> [options]');
    return;
  }

  const type = argv[0] as any;
  const title = argv[1];
  const options = parseOptions(argv.slice(2));

  if (!NodeType.safeParse(type).success) {
    console.error(`Invalid type: ${type}`);
    return;
  }

  const id = options.id || generateId(type, title);
  const now = Date.now();

  const node: NodeData = {
    id,
    type,
    status: (options.status || 'open') as any,
    title,
    description: options.description,
    owner: options.owner,
    session: options.session,
    commit: options.commit,
    created_at: now,
    updated_at: now,
    metrics: options.metrics ? JSON.parse(options.metrics) : undefined,
    metadata: options.metadata ? JSON.parse(options.metadata) : undefined,
  } as any;

  // Add type-specific fields
  if (type === 'Hypothesis') {
    (node as any).rationale = options.rationale || '';
    (node as any).expected_effect = options.expected_effect || '';
    (node as any).test_plan = options.test_plan || '';
  } else if (type === 'Task') {
    (node as any).acceptance_criteria = options.acceptance_criteria ? JSON.parse(options.acceptance_criteria) : [];
    (node as any).files = options.files ? JSON.parse(options.files) : [];
  } else if (type === 'Champion') {
    (node as any).version = options.version || 'unknown';
    (node as any).config_path = options.config_path || '';
    (node as any).promoted_at = now;
  }

  db.addNode(node);
  console.log(`Added node: ${id}`);
}

function updateNode(argv: string[]): void {
  // Usage: update <id> [--status=done] [--description="..."] ...
  if (argv.length < 1) {
    console.error('Usage: update <id> [options]');
    return;
  }

  const id = argv[0];
  const options = parseOptions(argv.slice(1));

  const existing = db.getNode(id);
  if (!existing) {
    console.error(`Node not found: ${id}`);
    return;
  }

  const updates: Partial<NodeData> = {};
  if (options.status) updates.status = options.status as any;
  if (options.description !== undefined) updates.description = options.description;
  if (options.owner) updates.owner = options.owner;
  if (options.session) updates.session = options.session;
  if (options.commit) updates.commit = options.commit;
  if (options.metrics) updates.metrics = JSON.parse(options.metrics);
  if (options.metadata) updates.metadata = JSON.parse(options.metadata);

  db.updateNode(id, updates);
  console.log(`Updated node: ${id}`);
}

function link(argv: string[]): void {
  // Usage: link <from_id> <edge_type> <to_id>
  if (argv.length < 3) {
    console.error('Usage: link <from_id> <edge_type> <to_id>');
    return;
  }

  const [fromId, edgeType, toId] = argv;

  if (!EdgeType.safeParse(edgeType).success) {
    console.error(`Invalid edge type: ${edgeType}`);
    return;
  }

  const edge: EdgeData = {
    id: `${fromId}-${edgeType}-${toId}`,
    from_node: fromId,
    to_node: toId,
    type: edgeType as any,
    created_at: Date.now(),
  };

  db.addEdge(edge);
  console.log(`Linked: ${fromId} --[${edgeType}]--> ${toId}`);
}

function render(): void {
  // Export graph to JSON and generate mermaid diagram
  const graph = db.exportGraph();
  
  // Write JSON export
  const stateDir = path.join(process.cwd(), 'state');
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
  
  fs.writeFileSync(
    path.join(stateDir, 'graph.json'),
    JSON.stringify(graph, null, 2)
  );
  console.log('Exported graph to state/graph.json');

  // Generate mermaid diagram
  const mermaid = generateMermaid(graph);
  fs.writeFileSync(path.join(stateDir, 'graph.mmd'), mermaid);
  console.log('Generated mermaid diagram: state/graph.mmd');

  // Generate simple HTML view
  const html = generateHTML(graph);
  fs.writeFileSync(path.join(stateDir, 'graph.html'), html);
  console.log('Generated HTML view: state/graph.html');
}

function generateMermaid(graph: any): string {
  let mmd = 'graph TD\n';
  
  // Add nodes
  graph.nodes.forEach((node: any) => {
    const shape = node.type === 'Champion' ? '([' : node.type === 'Goal' ? '{{' : '[';
    const shapeEnd = node.type === 'Champion' ? '])' : node.type === 'Goal' ? '}}' : ']';
    const label = `${node.type}: ${node.title.slice(0, 30)}`;
    mmd += `  ${node.id}${shape}"${label}"${shapeEnd}\n`;
  });

  // Add edges
  graph.edges.forEach((edge: any) => {
    mmd += `  ${edge.from_node} -->|${edge.type}| ${edge.to_node}\n`;
  });

  return mmd;
}

function generateHTML(graph: any): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Development Graph</title>
  <style>
    body { font-family: system-ui; margin: 20px; }
    .node { border: 1px solid #ccc; padding: 10px; margin: 10px 0; border-radius: 5px; }
    .node.Champion { background: #d4edda; }
    .node.Goal { background: #cce5ff; }
    .node.done { opacity: 0.6; }
    .edges { margin-top: 10px; font-size: 0.9em; color: #666; }
  </style>
</head>
<body>
  <h1>Development Graph</h1>
  <p>Exported: ${new Date(graph.exported_at).toISOString()}</p>
  
  <h2>Nodes (${graph.nodes.length})</h2>
  ${graph.nodes.map((n: any) => `
    <div class="node ${n.type} ${n.status}">
      <strong>${n.type}: ${n.title}</strong>
      <div>Status: ${n.status}</div>
      ${n.description ? `<div>${n.description}</div>` : ''}
      ${n.commit ? `<div>Commit: <code>${n.commit}</code></div>` : ''}
      ${n.metrics ? `<div>Metrics: ${JSON.stringify(n.metrics)}</div>` : ''}
    </div>
  `).join('')}
  
  <h2>Edges (${graph.edges.length})</h2>
  <ul>
  ${graph.edges.map((e: any) => `
    <li>${e.from_node} --[${e.type}]--> ${e.to_node}</li>
  `).join('')}
  </ul>
</body>
</html>`;
}

function query(argv: string[]): void {
  // Simple queries: by-type, by-status, by-id
  if (argv.length === 0) {
    console.error('Usage: query <by-type|by-status|by-id> <value>');
    return;
  }

  const mode = argv[0];
  const value = argv[1];

  if (mode === 'by-type') {
    const nodes = db.getNodesByType(value);
    console.log(`Found ${nodes.length} nodes of type ${value}:`);
    nodes.forEach(n => {
      console.log(`  ${n.id}: [${n.status}] ${n.title}`);
    });
  } else if (mode === 'by-status') {
    // Query all nodes with status
    const allTypes = ['Goal', 'Milestone', 'Task', 'Experiment', 'Hypothesis', 'Result', 'Decision', 'Learning', 'DataSource', 'Convention', 'Benchmark', 'Champion'];
    const nodes = allTypes.flatMap(type => db.getNodesByType(type, value));
    console.log(`Found ${nodes.length} nodes with status ${value}:`);
    nodes.forEach(n => {
      console.log(`  ${n.id}: [${n.type}] ${n.title}`);
    });
  } else if (mode === 'by-id') {
    const node = db.getNode(value);
    if (!node) {
      console.log(`Node not found: ${value}`);
      return;
    }
    console.log(JSON.stringify(node, null, 2));
  } else {
    console.error(`Unknown query mode: ${mode}`);
  }
}

function parseOptions(argv: string[]): Record<string, string> {
  const opts: Record<string, string> = {};
  argv.forEach(arg => {
    if (arg.startsWith('--')) {
      const [key, ...valueParts] = arg.slice(2).split('=');
      opts[key] = valueParts.join('=') || 'true';
    }
  });
  return opts;
}

// Main CLI
const args = process.argv.slice(2);
if (args.length === 0) {
  console.log('Usage: graph <command> [args]');
  console.log('Commands: status, next, add, update, link, render, query');
  process.exit(1);
}

const command = args[0];
const commandArgs = args.slice(1);

try {
  switch (command) {
    case 'status':
      status();
      break;
    case 'next':
      next();
      break;
    case 'add':
      addNode(commandArgs);
      break;
    case 'update':
      updateNode(commandArgs);
      break;
    case 'link':
      link(commandArgs);
      break;
    case 'render':
      render();
      break;
    case 'query':
      query(commandArgs);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
} finally {
  db.close();
}
