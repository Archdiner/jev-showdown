import * as fs from 'fs';
import * as path from 'path';
import type { LossFinding } from '../llm/loss-reviewer.js';
import type { AnalystGame } from './ingest.js';

/** One decision row from a ladder per-battle JSONL file. */
export interface LadderDecision {
  turn: number;
  choice: string;
  fallback: boolean;
  request: unknown | null;
  battleId: string | null;
}

const AGGREGATE_LOGS = new Set(['games.jsonl', 'live-games.jsonl']);

/**
 * Turn rows in a per-battle ladder log. The file is JSONL events, not a
 * `>start` input log and not a `|request|` protocol stream.
 */
export function readLadderDecisions(file: string): LadderDecision[] {
  if (!file || !fs.existsSync(file)) return [];
  const decisions: LadderDecision[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const kind = record.type ?? record.kind;
    if (kind !== 'turn' || typeof record.turn !== 'number' || !Number.isFinite(record.turn)) continue;
    decisions.push({
      turn: record.turn,
      choice: typeof record.choice === 'string' ? record.choice : '',
      fallback: record.fallback === true,
      request: record.request && typeof record.request === 'object' ? record.request : null,
      battleId: typeof record.battleId === 'string' ? record.battleId : null,
    });
  }
  return decisions;
}

/** Attach turn rows from the per-battle file. Aggregate `games.jsonl` rows are not turn logs. */
export function attachLadderDecisions(games: AnalystGame[]): AnalystGame[] {
  const cache = new Map<string, LadderDecision[]>();
  return games.map(game => {
    const decisions: LadderDecision[] = [];
    for (const file of decisionFiles(game)) {
      const rows = cache.get(file) ?? readLadderDecisions(file);
      cache.set(file, rows);
      for (const row of rows) {
        if (game.battleId && row.battleId && row.battleId !== game.battleId) continue;
        decisions.push(row);
      }
    }
    return { ...game, ladderDecisions: dedupeDecisions(decisions) };
  });
}

/**
 * Protocol text the miner can replay. A replay that already contains `|request|`
 * wins. Otherwise the public log is kept and each stored request object is
 * appended as a `|request|` line.
 */
export function protocolFromGame(game: AnalystGame): string {
  const base = richerProtocol(game);
  if (base.includes('|request|')) return base;
  const extra = requestLines(game.ladderDecisions ?? []);
  if (!extra) return base;
  return base ? `${base}\n${extra}` : extra;
}

/**
 * Class and critical turn from the played choice. A missing choice leaves the
 * caller on the generic turn-0 fallback.
 */
export function findingFromLadderLog(decisions: LadderDecision[]): LossFinding | null {
  const played = decisions.filter(row => row.choice && !isTeamChoice(row.choice));
  if (played.length === 0) return null;
  const picked = [...played].reverse().find(row => row.fallback) ?? played[played.length - 1];
  const mistakeClass = classOf(picked.choice);
  return {
    criticalTurn: picked.turn,
    mistakeClass,
    summary: `Played ${picked.choice} on turn ${picked.turn}.`,
    hypothesis: {
      title: 'Live loss',
      rationale: 'The played line is a general mechanism or eval term.',
      expectedEffect: 'Changing that term raises paired win rate on the dev set.',
      testPlan: 'Sweep the term on paired games and the dev set. Do not add a species rule.',
      killCondition: 'No dev-set or win-rate gain, or held-out agreement drops.',
    },
  };
}

/** Prefix the protocol with the turn choices so a reviewer clip still sees them. */
export function reviewTextFor(game: AnalystGame): string {
  const lines = (game.ladderDecisions ?? [])
    .filter(row => row.choice)
    .map(row => `turn ${row.turn} choice ${row.choice}${row.fallback ? ' fallback' : ''}`);
  const protocol = protocolFromGame(game);
  return lines.length ? `${lines.join('\n')}\n${protocol}` : protocol;
}

function decisionFiles(game: AnalystGame): string[] {
  const files: string[] = [];
  const add = (file: string | null | undefined) => {
    if (!file || !file.endsWith('.jsonl')) return;
    if (AGGREGATE_LOGS.has(path.basename(file))) return;
    if (!fs.existsSync(file) || files.includes(file)) return;
    files.push(file);
  };
  add(game.sourcePath);
  add(game.logPath);
  const battleId = game.battleId;
  if (!battleId) return files;
  const dirs = new Set<string>();
  if (game.sourcePath) dirs.add(path.dirname(game.sourcePath));
  if (game.logPath) dirs.add(path.dirname(game.logPath));
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl') || AGGREGATE_LOGS.has(name)) continue;
      if (!name.includes(battleId)) continue;
      add(path.join(dir, name));
    }
  }
  return files;
}

function richerProtocol(game: AnalystGame): string {
  const embedded = game.log || '';
  if (embedded.includes('|request|')) return embedded;
  for (const file of replayFiles(game)) {
    const text = readText(file);
    if (text.includes('|request|')) return text;
  }
  return embedded;
}

function replayFiles(game: AnalystGame): string[] {
  const files: string[] = [];
  const add = (file: string) => {
    if (!file.endsWith('.log') || files.includes(file) || !fs.existsSync(file)) return;
    files.push(file);
  };
  const battleId = game.battleId;
  const dirs = new Set<string>();
  for (const start of [game.logPath, game.sourcePath]) {
    if (!start) continue;
    dirs.add(path.dirname(start));
    dirs.add(path.join(path.dirname(start), 'replays'));
  }
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.log')) continue;
      if (battleId && !name.includes(battleId) && !name.includes(battleId.replace(/[^a-z0-9]+/gi, ''))) continue;
      if (!battleId) continue;
      add(path.join(dir, name));
    }
  }
  return files;
}

function requestLines(decisions: LadderDecision[]): string {
  const lines: string[] = [];
  for (const row of decisions) {
    if (!row.request || typeof row.request !== 'object') continue;
    try {
      lines.push(`|request|${JSON.stringify(row.request)}`);
    } catch {
      // A request that cannot be serialized is not a protocol line.
    }
  }
  return lines.join('\n');
}

function dedupeDecisions(rows: LadderDecision[]): LadderDecision[] {
  const byKey = new Map<string, LadderDecision>();
  for (const row of rows) {
    const key = `${row.battleId ?? ''}|${row.turn}|${row.choice}|${row.fallback ? 1 : 0}`;
    const prev = byKey.get(key);
    if (!prev || (!prev.request && row.request)) byKey.set(key, row);
  }
  return [...byKey.values()];
}

function classOf(choice: string): LossFinding['mistakeClass'] {
  const text = choice.toLowerCase();
  if (text.includes('terastallize') || /\btera\b/.test(text)) return 'tera-timing';
  if (text.startsWith('switch') || text.includes(' switch ')) return 'switch-timing';
  if (text.startsWith('move') || text.includes(' move ')) return 'move-choice';
  return 'other';
}

function isTeamChoice(choice: string): boolean {
  return /^team\b/i.test(choice.trim());
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
