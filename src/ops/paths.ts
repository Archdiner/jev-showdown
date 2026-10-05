import * as fs from 'fs';
import * as path from 'path';

export interface OpsPaths {
  root: string;
  graph: string;
  heartbeats: string;
  liveGames: string;
  circuits: string;
  analystOffset: string;
  seenGames: string;
  regressionSuite: string;
  priors: string;
  pool: string;
  variants: string;
}

const DEFAULT_ROOT = path.join(process.cwd(), 'state', 'ops');

export function opsPaths(root = process.env.OPS_DIR || DEFAULT_ROOT): OpsPaths {
  const graph = process.env.GRAPH_DB
    || (path.resolve(root) === path.resolve(DEFAULT_ROOT)
      ? path.join(process.cwd(), 'state', 'graph.db')
      : path.join(root, 'graph.db'));
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.dirname(graph), { recursive: true });
  const priors = process.env.JEV_PRIORS_FILE || path.join(root, 'behavior.json');
  fs.mkdirSync(path.dirname(priors), { recursive: true });
  return {
    root,
    graph,
    heartbeats: path.join(root, 'heartbeats.jsonl'),
    liveGames: path.join(root, 'live-games.jsonl'),
    circuits: path.join(root, 'circuits.json'),
    analystOffset: path.join(root, 'analyst.offset'),
    seenGames: path.join(root, 'analyst-seen.json'),
    regressionSuite: path.join(root, 'regression-suite.jsonl'),
    priors,
    pool: path.join(root, 'mined-pool.json'),
    variants: path.join(root, 'variants.json'),
  };
}

export function appendJsonl(file: string, record: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

export function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as T);
}
