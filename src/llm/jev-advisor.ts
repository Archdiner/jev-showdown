import type { GatewayClient } from './gateway-client.js';
import type { EvaluateQuestion } from './gateway-client.js';
import { JEV_MODEL_ID } from './models.js';
import { buildBattleFacts, type BattleFacts } from './battle-facts.js';
import { capEvaluationState, toAdvisorCandidates } from './state-summary.js';
import type { AdvisorAssessment, AdvisorCandidate } from './types.js';
import type { GameState, RandbatsStats } from '../types/index.js';
import type { ScoredAction } from './types.js';
import { dataLoader } from '../data/data-loader.js';
import { installPosthogSink } from '../client/posthog-sink.js';

export interface AdviseOptions {
  /** Extra context from the config context layer, prepended to the calc sheet. */
  contextText?: string;
  /** Use these facts instead of rebuilding the calc sheet. */
  facts?: BattleFacts;
  questions?: {
    bestAction?: boolean;
    opponentWillSwitch?: boolean;
    score?: boolean;
  };
}

const SCORE_LEVELS = [
  'blunder: clearly the wrong action',
  'poor: worse than the alternatives',
  'even: comparable to the alternatives',
  'good: better than most alternatives',
  'best: the strongest action this turn',
];

/**
 * Jev is an evaluation model. It is called with POST /v1/evaluate only.
 * Chat completions reject it with ModelTypeMismatchError.
 */
export class JevAdvisor {
  constructor(
    private readonly client: GatewayClient,
    private readonly model: string = JEV_MODEL_ID
  ) {}

  async adviseFromState(
    state: GameState,
    scored: ScoredAction[],
    topK: number,
    pools?: RandbatsStats,
    options?: AdviseOptions
  ): Promise<{ assessment: AdvisorAssessment; candidates: AdvisorCandidate[] }> {
    const candidates = toAdvisorCandidates(scored, topK);
    const assessment = await this.advise(state, candidates, pools, options);
    return { assessment, candidates };
  }

  async advise(
    state: GameState,
    candidates: AdvisorCandidate[],
    pools?: RandbatsStats,
    options?: AdviseOptions
  ): Promise<AdvisorAssessment> {
    installPosthogSink();
    if (candidates.length === 0) {
      return emptyAssessment(this.model, true, 'no_candidates');
    }

    const facts = options?.facts ?? buildBattleFacts(state, candidates, pools ?? loadedPools());
    const ask = {
      bestAction: options?.questions?.bestAction !== false,
      opponentWillSwitch: options?.questions?.opponentWillSwitch !== false,
      score: options?.questions?.score !== false,
    };
    const questions: Record<string, EvaluateQuestion> = {};
    if (ask.bestAction) {
      questions.bestAction = {
        type: 'choice',
        instructions:
          'Which candidate is best this turn? Use only the damage rolls, accuracy, priority, speed, and search scores in the state. ' +
          'Do not apply a type matchup that the state does not already state as a damage number.',
        criteria: Object.fromEntries(candidates.map(candidate => [candidate.id, facts.criteria[candidate.id] ?? candidate.label])),
      };
    }
    if (ask.opponentWillSwitch) {
      questions.opponentWillSwitch = {
        type: 'boolean',
        instructions: 'Will the opponent switch to a different Pokemon this turn?',
        criteria: {
          true: 'the opponent switches',
          false: 'the opponent stays in and acts with the active Pokemon',
        },
      };
    }
    if (ask.score) {
      for (const candidate of candidates) {
        questions[`score_${candidate.id}`] = {
          type: 'score',
          instructions: `How good is this action given these calc numbers: ${facts.criteria[candidate.id] ?? candidate.label}`,
          criteria: SCORE_LEVELS,
        };
      }
    }
    if (Object.keys(questions).length === 0) {
      return emptyAssessment(this.model, true, 'no_questions');
    }

    const stateText = capEvaluationState(
      [options?.contextText?.trim(), facts.text.trim()].filter(Boolean).join('\n')
    );
    const result = await this.client.evaluate({
      model: this.model,
      state: stateText,
      questions,
    });

    if (!result.ok) {
      return emptyAssessment(this.model, true, result.error, result.metrics.latencyMs, result.metrics.costUsd);
    }

    const scores: Record<string, number> = {};
    const probabilities: Record<string, number> = {};
    const booleans: Record<string, number> = {};
    const answers = result.data.answers;
    const best = answers.bestAction;

    if (best?.probabilities) {
      for (const candidate of candidates) {
        const value = best.probabilities[candidate.id];
        if (typeof value === 'number') probabilities[candidate.id] = value;
      }
    }

    for (const candidate of candidates) {
      const answer = answers[`score_${candidate.id}`];
      if (typeof answer?.score === 'number') {
        scores[candidate.id] = clamp01(answer.score / (SCORE_LEVELS.length - 1));
      }
    }

    for (const [name, answer] of Object.entries(answers)) {
      if (answer?.type === 'boolean' && typeof answer.probability === 'number') {
        booleans[name] = clamp01(answer.probability);
      }
    }

    if (Object.keys(scores).length === 0 && Object.keys(probabilities).length === 0 && Object.keys(booleans).length === 0) {
      return emptyAssessment(this.model, true, 'unusable_answers', result.metrics.latencyMs, result.metrics.costUsd);
    }

    if (Object.keys(scores).length > 0 || Object.keys(probabilities).length > 0) {
      fillFromSibling(candidates, scores, probabilities);
    }

    return {
      model: result.data.model || this.model,
      scores,
      probabilities,
      booleans,
      degraded: false,
      latencyMs: result.metrics.latencyMs,
      costUsd: result.metrics.costUsd,
    };
  }
}

function fillFromSibling(
  candidates: AdvisorCandidate[],
  scores: Record<string, number>,
  probabilities: Record<string, number>
): void {
  const haveScores = Object.keys(scores).length > 0;
  const haveProbs = Object.keys(probabilities).length > 0;

  if (!haveProbs && haveScores) {
    const total = candidates.reduce((sum, candidate) => sum + Math.max(0, scores[candidate.id] ?? 0), 0);
    for (const candidate of candidates) {
      probabilities[candidate.id] = total > 0 ? Math.max(0, scores[candidate.id] ?? 0) / total : 1 / candidates.length;
    }
  }

  if (!haveScores && haveProbs) {
    for (const candidate of candidates) {
      scores[candidate.id] = probabilities[candidate.id] ?? 0;
    }
  }

  for (const candidate of candidates) {
    if (scores[candidate.id] == null) scores[candidate.id] = 0;
    if (probabilities[candidate.id] == null) probabilities[candidate.id] = 0;
  }
}

function emptyAssessment(
  model: string,
  degraded: boolean,
  reason: string,
  latencyMs = 0,
  costUsd = 0
): AdvisorAssessment {
  return { model, scores: {}, probabilities: {}, booleans: {}, degraded, reason, latencyMs, costUsd };
}

function loadedPools(): RandbatsStats {
  try {
    return dataLoader.getStats();
  } catch {
    return {};
  }
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
