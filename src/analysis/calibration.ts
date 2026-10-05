import * as fs from 'fs';
import * as path from 'path';
import {
  CalibrationSample,
  CalibrationSummary,
  PredictionBaseline,
  combineCalibrations,
  dedupeSamples,
  formatCalibrationReport,
  resolutionsAfterRequests,
  sampleFromRow,
  scoreResolution,
  scoreToSample,
  summarizeSamples,
} from '../client/prediction.js';
import { TurnForecast, TURN_FORECAST_SCHEMA } from '../client/turn-forecast.js';

export interface CalibrationReport {
  dir: string;
  files: number;
  summary: CalibrationSummary | null;
  byEngine: Array<{ engine: string; summary: CalibrationSummary }>;
  text: string;
}

interface PendingTurn {
  battleId: string | null;
  turn: number;
  rqid: number | null;
  engine: string | null;
  forecast: TurnForecast;
  baseline: PredictionBaseline;
}

function isForecast(value: unknown): value is TurnForecast {
  if (!value || typeof value !== 'object') return false;
  const row = value as TurnForecast;
  return row.schema === TURN_FORECAST_SCHEMA && typeof row.ourChoice === 'string';
}

function isBaseline(value: unknown): value is PredictionBaseline {
  if (!value || typeof value !== 'object') return false;
  const row = value as PredictionBaseline;
  return row.ourSide === 'p1' || row.ourSide === 'p2';
}

function readLines(file: string): string[] {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/);
}

function replayPath(jsonlPath: string, hinted: string | null): string | null {
  if (hinted && fs.existsSync(hinted)) return hinted;
  const candidate = path.join(path.dirname(jsonlPath), 'replays', `${path.basename(jsonlPath, '.jsonl')}.log`);
  if (fs.existsSync(candidate)) return candidate;
  return null;
}

function rescoreFile(file: string, pending: PendingTurn[], hintedReplay: string | null): CalibrationSample[] {
  if (pending.length === 0) return [];
  const replay = replayPath(file, hintedReplay);
  if (!replay) return [];
  let protocol: string[];
  try {
    protocol = readLines(replay).map(line => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
  const segments = resolutionsAfterRequests(protocol);
  if (segments.length !== pending.length) return [];
  const out: CalibrationSample[] = [];
  for (let i = 0; i < pending.length; i++) {
    const turn = pending[i];
    try {
      const score = scoreResolution({
        forecast: turn.forecast,
        baseline: turn.baseline,
        lines: segments[i],
        turn: turn.turn,
        rqid: turn.rqid,
      });
      out.push(scoreToSample(score, { battleId: turn.battleId, engine: turn.engine }));
    } catch {
      // One bad turn does not drop the file.
    }
  }
  return out;
}

function fromJsonl(file: string): CalibrationSample[] {
  const scored = new Set<string>();
  const samples: CalibrationSample[] = [];
  const pending: PendingTurn[] = [];
  let hintedReplay: string | null = null;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const sample = sampleFromRow(row);
    if (sample) {
      samples.push(sample);
      scored.add(`${sample.battleId ?? ''}:${sample.turn ?? ''}:${sample.rqid ?? ''}`);
    }
    if (typeof row.localReplayPath === 'string') hintedReplay = row.localReplayPath;
    if (String(row.type || row.kind || '') !== 'turn' || !isForecast(row.prediction) || !isBaseline(row.predictionBaseline)) {
      continue;
    }
    const battleId = typeof row.battleId === 'string' ? row.battleId : null;
    const turn = typeof row.turn === 'number' ? row.turn : 0;
    const rqid = typeof row.rqid === 'number' ? row.rqid : null;
    const key = `${battleId ?? ''}:${turn}:${rqid ?? ''}`;
    if (scored.has(key)) continue;
    pending.push({
      battleId,
      turn,
      rqid,
      engine: typeof row.engine === 'string' ? row.engine : null,
      forecast: row.prediction,
      baseline: row.predictionBaseline,
    });
  }
  samples.push(...rescoreFile(file, pending, hintedReplay));
  return samples;
}

export function loadCalibration(dir: string): CalibrationSample[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  const visit = (current: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith('.jsonl')) files.push(full);
    }
  };
  visit(dir);
  const samples: CalibrationSample[] = [];
  for (const file of files.sort()) samples.push(...fromJsonl(file));
  return dedupeSamples(samples);
}

export function buildCalibrationReport(dir: string): CalibrationReport {
  const samples = loadCalibration(dir);
  const summary = summarizeSamples(samples);
  const engines = new Map<string, CalibrationSample[]>();
  for (const sample of samples) {
    const engine = sample.engine || 'unknown';
    const rows = engines.get(engine) ?? [];
    rows.push(sample);
    engines.set(engine, rows);
  }
  const byEngine = [...engines.entries()]
    .map(([engine, rows]) => ({ engine, summary: summarizeSamples(rows) }))
    .filter((row): row is { engine: string; summary: CalibrationSummary } => row.summary !== null)
    .sort((a, b) => a.engine.localeCompare(b.engine));
  const lines = [formatCalibrationReport(summary, `Sim calibration  ${dir}`)];
  if (byEngine.length > 1) {
    lines.push('', 'by engine:');
    for (const row of byEngine) {
      const item = row.summary;
      lines.push(
        `  ${row.engine}  foe ${item.foeActionCorrect}/${item.foeActions}`
        + `  dealt MAE ${item.damageDealtMae ?? 'n/a'}`
        + `  taken MAE ${item.damageTakenMae ?? 'n/a'}`
        + `  KO ${item.koErrors}/${item.koCompared}`
        + `  speed ${item.speedOrderErrors}/${item.speedCompared}`,
      );
    }
  }
  return {
    dir,
    files: samples.length,
    summary: combineCalibrations([summary]),
    byEngine,
    text: lines.join('\n'),
  };
}
