import * as fs from 'fs';
import { z } from 'zod';
import type { GraphDB } from '../graph/db.js';
import type { GatewayClient } from './gateway-client.js';
import { resolveReviewerModel } from './models.js';
import type { CallMetrics } from './gateway-client.js';
import { buildBattleFacts } from './battle-facts.js';
import type { GameState, RandbatsStats } from '../types/index.js';
import type { AdvisorCandidate } from './types.js';

export const MISTAKE_CLASSES = [
  'speed-control',
  'hazard-misplay',
  'switch-timing',
  'tera-timing',
  'move-choice',
  'prediction',
  'endgame',
  'information',
  'other',
] as const;

export const LossFindingSchema = z.object({
  criticalTurn: z.number().int().nonnegative(),
  mistakeClass: z.enum(MISTAKE_CLASSES),
  summary: z.string().min(1),
  hypothesis: z.object({
    title: z.string().min(1),
    rationale: z.string().min(1),
    expectedEffect: z.string().min(1),
    testPlan: z.string().min(1),
    killCondition: z.string().min(1),
  }),
});

export type LossFinding = z.infer<typeof LossFindingSchema>;

export interface ReviewResult {
  ok: boolean;
  finding?: LossFinding;
  hypothesisId?: string;
  error?: string;
  metrics?: CallMetrics;
  model: string;
}

const FINDING_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['criticalTurn', 'mistakeClass', 'summary', 'hypothesis'],
  properties: {
    criticalTurn: { type: 'integer' },
    mistakeClass: { type: 'string', enum: [...MISTAKE_CLASSES] },
    summary: { type: 'string' },
    hypothesis: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'rationale', 'expectedEffect', 'testPlan', 'killCondition'],
      properties: {
        title: { type: 'string' },
        rationale: { type: 'string' },
        expectedEffect: { type: 'string' },
        testPlan: { type: 'string' },
        killCondition: { type: 'string' },
      },
    },
  },
};

const MAX_LOG_CHARS = 20000;

export class LossReviewer {
  constructor(
    private readonly client: GatewayClient,
    private readonly model: string = resolveReviewerModel()
  ) {}

  async reviewFile(filePath: string, opts: { db?: GraphDB; battleId?: string } = {}): Promise<ReviewResult> {
    const text = readBattleSource(filePath);
    return this.review(text, { ...opts, sourcePath: filePath });
  }

  async review(
    battleText: string,
    opts: {
      db?: GraphDB;
      battleId?: string;
      sourcePath?: string;
      calcText?: string;
      state?: GameState;
      candidates?: AdvisorCandidate[];
      pools?: RandbatsStats;
    } = {}
  ): Promise<ReviewResult> {
    const clipped = battleText.length > MAX_LOG_CHARS;
    const transcript = clipped ? battleText.slice(0, MAX_LOG_CHARS) : battleText;
    const calcText = opts.calcText ?? (opts.state ? buildBattleFacts(opts.state, opts.candidates ?? [], opts.pools).text : undefined);
    const messages = buildReviewMessages(transcript, calcText, clipped);
    const result = await this.client.chat({
      model: this.model,
      temperature: 0,
      maxTokens: 1200,
      jsonSchema: FINDING_JSON_SCHEMA,
      messages: [
        { role: 'system', content: messages.system },
        { role: 'user', content: messages.user },
      ],
    });

    if (!result.ok) {
      return { ok: false, error: result.error, metrics: result.metrics, model: this.model };
    }

    const parsed = parseFinding(result.data);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error, metrics: result.metrics, model: this.model };
    }

    let hypothesisId: string | undefined;
    if (opts.db) {
      hypothesisId = writeFindingAsHypothesis(opts.db, parsed.finding, {
        model: this.model,
        battleId: opts.battleId,
        sourcePath: opts.sourcePath,
        costUsd: result.metrics.costUsd,
        latencyMs: result.metrics.latencyMs,
      });
    }

    return {
      ok: true,
      finding: parsed.finding,
      hypothesisId,
      metrics: result.metrics,
      model: this.model,
    };
  }
}

export function buildReviewMessages(
  battleText: string,
  calcText: string | undefined,
  clipped = false
): { system: string; user: string } {
  const calc = calcText?.trim()
    ? calcText
    : 'NONE. No calc block was supplied. Do not claim any damage range, KO chance, speed order, or type effectiveness.';
  return {
    system:
      'You review one lost Gen 9 Random Battle played by a search-based bot. ' +
      'Return only JSON matching the schema. Identify the single most critical turn, ' +
      'a mistake class, and a hypothesis the champion/challenger gate can test. ' +
      'Do not propose editing code directly. The hypothesis must include a kill condition. ' +
      'Ground every claim about damage, KO chance, accuracy, priority, speed, or type effectiveness in the CALC block. ' +
      'Quote those numbers. Do not assert type matchups, immunities, or resistances from memory. ' +
      'If the CALC block does not state a matchup as a damage number, do not claim it. ' +
      'The hypothesis must be a general mechanism or eval term. Do not write a rule for this position, and do not name a species or a move to click.',
    user:
      `${clipped ? 'The log was truncated to the first 20000 characters.\n' : ''}` +
      `CALC (from @pkmn/dex, @smogon/calc, and the randbats role pool; this is the only source for matchup facts):\n${calc}\n\n` +
      `BATTLE LOG:\n${battleText}`,
  };
}

export function parseFinding(raw: string): { ok: true; finding: LossFinding } | { ok: false; error: string } {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const finding = LossFindingSchema.parse(JSON.parse(stripped));
    return { ok: true, finding };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'invalid_finding' };
  }
}

/**
 * Record a reviewer finding as a Hypothesis. This does not change bot code or champion config.
 */
export function writeFindingAsHypothesis(
  db: GraphDB,
  finding: LossFinding,
  source: { model: string; battleId?: string; sourcePath?: string; costUsd?: number; latencyMs?: number }
): string {
  const now = Date.now();
  const slug = (source.battleId || source.sourcePath || 'loss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40);
  const id = `hyp-loss-${slug}-${now.toString(36)}`;

  db.addNode({
    id,
    type: 'Hypothesis',
    status: 'open',
    title: finding.hypothesis.title,
    description:
      `Loss-review finding. Critical turn ${finding.criticalTurn}, class ${finding.mistakeClass}. ` +
      `${finding.summary} Not applied to code; submit through the gate if tested.`,
    created_at: now,
    updated_at: now,
    rationale: finding.hypothesis.rationale,
    expected_effect: finding.hypothesis.expectedEffect,
    test_plan: finding.hypothesis.testPlan,
    metrics: {
      critical_turn: finding.criticalTurn,
      cost_usd: source.costUsd ?? 0,
      latency_ms: source.latencyMs ?? 0,
    },
    metadata: {
      source: 'loss-reviewer',
      autoApplied: false,
      mistakeClass: finding.mistakeClass,
      criticalTurn: finding.criticalTurn,
      killCondition: finding.hypothesis.killCondition,
      model: source.model,
      battleId: source.battleId ?? null,
      sourcePath: source.sourcePath ?? null,
    },
  });

  return id;
}

export function readBattleSource(filePath: string): string {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (filePath.endsWith('.jsonl') || looksLikeJsonl(raw)) {
    return formatJsonl(raw);
  }
  return raw;
}

export function formatJsonl(raw: string): string {
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.turn != null) {
        const detail = record.message ?? record.log ?? record.action ?? record;
        return `Turn ${String(record.turn)}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
      }
      return JSON.stringify(record);
    })
    .join('\n');
}

function looksLikeJsonl(raw: string): boolean {
  const lines = raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every(line => {
    try {
      return typeof JSON.parse(line) === 'object' && JSON.parse(line) !== null;
    } catch {
      return false;
    }
  });
}
