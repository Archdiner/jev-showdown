import * as path from 'path';
import { checkGameInvariants, readGameObjects, repairGameLog, type InvariantFinding } from '../client/game-integrity.js';

export function scanGameLog(file: string): InvariantFinding[] {
  return checkGameInvariants(readGameObjects(file));
}

export function formatFindings(file: string, findings: InvariantFinding[]): string {
  if (findings.length === 0) return `${file}: ok`;
  const lines = [`${file}: ${findings.length} invariant break${findings.length === 1 ? '' : 's'}`];
  for (const finding of findings) {
    lines.push(`  ${finding.code} ${finding.detail}`);
  }
  return lines.join('\n');
}

export function defaultGameLogs(cwd = process.cwd()): string[] {
  return [
    path.join(cwd, 'logs', 'ladder', 'games.jsonl'),
    path.join(cwd, 'state', 'ops', 'live-games.jsonl'),
  ];
}

export function runSentinel(files: string[]): { text: string; findings: number } {
  if (files.length === 0) return { text: 'no game log to check', findings: 0 };
  const scanned = files.map(file => ({ file, findings: scanGameLog(file) }));
  return {
    text: scanned.map(item => formatFindings(item.file, item.findings)).join('\n'),
    findings: scanned.reduce((sum, item) => sum + item.findings.length, 0),
  };
}

export function runRepair(files: string[]): string {
  if (files.length === 0) return 'no game log to repair';
  return files.map(file => {
    const result = repairGameLog(file);
    return `${file}: flagged ${result.flagged}`;
  }).join('\n');
}
