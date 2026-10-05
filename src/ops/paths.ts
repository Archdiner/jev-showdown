import * as fs from 'fs';
import * as path from 'path';

export interface OpsPaths {
  root: string;
  graph: string;
  heartbeats: string;
  liveGames: string;
  circuits: string;
  analystOffset: string;
  analystFiles: string;
  seenGames: string;
  regressionSuite: string;
  priors: string;
  pool: string;
  variants: string;
  cycle: string;
  dispositions: string;
  hypotheses: string;
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
    analystFiles: path.join(root, 'analyst-files.json'),
    seenGames: path.join(root, 'analyst-seen.json'),
    regressionSuite: path.join(root, 'regression-suite.jsonl'),
    priors,
    pool: path.join(root, 'mined-pool.json'),
    variants: path.join(root, 'variants.json'),
    cycle: path.join(root, 'cycle.jsonl'),
    dispositions: path.join(root, 'dispositions.jsonl'),
    hypotheses: path.join(root, 'hypotheses.json'),
  };
}

/** POSIX appends are atomic up to PIPE_BUF. Keep each JSONL record inside that. */
export const JSONL_LINE_MAX = 4096;

export function jsonlLine(record: unknown): string {
  const encode = (value: unknown) => `${JSON.stringify(value)}\n`;
  const fits = (line: string) => Buffer.byteLength(line) <= JSONL_LINE_MAX;
  if (fits(encode(record))) return encode(record);
  if (!record || typeof record !== 'object' || Array.isArray(record)) return encode({ truncated: true });
  const copy: Record<string, unknown> = { ...(record as Record<string, unknown>), truncated: true };
  const keys = Object.keys(copy)
    .filter(key => typeof copy[key] === 'string')
    .sort((a, b) => String(copy[b]).length - String(copy[a]).length);
  for (const key of keys) {
    let text = String(copy[key]);
    while (text.length > 0) {
      text = text.slice(0, Math.floor(text.length / 2));
      copy[key] = text;
      const line = encode(copy);
      if (fits(line)) return line;
      if (text.length < 8) break;
    }
    copy[key] = '';
    const emptied = encode(copy);
    if (fits(emptied)) return emptied;
  }
  return encode({ truncated: true });
}

export function appendJsonl(file: string, record: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, jsonlLine(record));
}

/** Parse complete lines. A trailing partial line is left unconsumed. A bad line is skipped. */
export function consumeJsonl(buf: Buffer): { records: unknown[]; bytes: number; corrupt: number } {
  let consumed = 0;
  let corrupt = 0;
  const records: unknown[] = [];
  let start = 0;
  for (let index = 0; index < buf.length; index++) {
    if (buf[index] !== 0x0a) continue;
    const line = buf.subarray(start, index).toString('utf8').trim();
    if (line) {
      try {
        records.push(JSON.parse(line));
      } catch {
        corrupt += 1;
      }
    }
    start = index + 1;
    consumed = start;
  }
  return { records, bytes: consumed, corrupt };
}

export function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as T);
}
