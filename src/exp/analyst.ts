import type { Battle } from '@pkmn/sim';
import type { SideId } from '../engine/exact/battle-utils.js';
import { writeFindingAsHypothesis, type LossFinding } from '../llm/loss-reviewer.js';
import type { GraphDB } from '../graph/db.js';
import type { BuiltBot } from '../config/bot.js';
import { minePosition } from '../config/positions.js';
import type { PositionRecord } from '../config/interfaces.js';
import { assertGeneralValue } from '../config/specificity.js';

const TARGET: Record<string, { kind: 'mechanism' | 'eval-term'; id: string }> = {
  'speed-control': { kind: 'mechanism', id: 'speed-control' },
  'hazard-misplay': { kind: 'mechanism', id: 'hazard-control' },
  'switch-timing': { kind: 'mechanism', id: 'switch-timing' },
  'tera-timing': { kind: 'mechanism', id: 'tera-timing' },
  'move-choice': { kind: 'eval-term', id: 'hpDifference' },
  prediction: { kind: 'mechanism', id: 'prediction' },
  endgame: { kind: 'mechanism', id: 'endgame' },
  information: { kind: 'mechanism', id: 'information' },
  other: { kind: 'eval-term', id: 'preservation' },
};

/**
 * A loss becomes a mechanism or an eval term. The model's position-specific
 * wording is discarded. Mined positions are split by hash into dev / held-out.
 */
export function generalizeFinding(finding: LossFinding): LossFinding {
  const target = TARGET[finding.mistakeClass] ?? TARGET.other;
  const summary = target.kind === 'eval-term'
    ? `Adjust the ${target.id} eval term and measure paired win rate plus dev-set agreement.`
    : `Change the ${target.id} mechanism and measure paired win rate plus dev-set agreement.`;
  const generalized: LossFinding = {
    criticalTurn: finding.criticalTurn,
    mistakeClass: finding.mistakeClass,
    summary,
    hypothesis: {
      title: `${target.kind}: ${target.id}`,
      rationale: summary,
      expectedEffect: `A better ${target.id} ${target.kind} raises panel win rate without dropping held-out agreement.`,
      testPlan: `Sweep ${target.id} on paired games and the dev position set only. Do not fit one position.`,
      killCondition: 'No win-rate or dev-agreement gain, or the gate held-out set or live results get worse.',
    },
  };
  assertGeneralValue(generalized, 'hypothesis');
  return generalized;
}

export async function analyzeLoss(
  bot: BuiltBot,
  battleText: string,
  opts: {
    db?: GraphDB;
    battleId?: string;
    mine?: { battle: Battle; side: SideId; seed: number; outPath?: string };
  } = {}
): Promise<{ ok: boolean; finding?: LossFinding; hypothesisId?: string; position?: PositionRecord; error?: string }> {
  const review = await bot.reviewLoss(battleText, { db: undefined, battleId: opts.battleId });
  if (!review.ok || !review.finding) return { ok: false, error: review.error || 'no finding' };
  const finding = generalizeFinding(review.finding);
  let hypothesisId: string | undefined;
  if (opts.db) {
    hypothesisId = writeFindingAsHypothesis(opts.db, finding, {
      model: review.model,
      battleId: opts.battleId,
      costUsd: review.metrics?.costUsd,
      latencyMs: review.metrics?.latencyMs,
    });
  }
  const position = opts.mine ? minePosition(opts.mine) : undefined;
  return { ok: true, finding, hypothesisId, position };
}
