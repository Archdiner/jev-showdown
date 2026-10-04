import type { JevAdvisor } from './jev-advisor.js';
import type {
  AdvisorAssessment,
  AdvisorCandidate,
  BlendConfig,
  BlendOutcome,
  CandidateSearch,
  RankedCandidate,
} from './types.js';
import { DEFAULT_BLEND_CONFIG } from './types.js';
import type { Action, GameState } from '../types/index.js';

export function blendConfigForBot(
  bot: { useLLMPrior: boolean },
  override: Partial<BlendConfig> = {}
): BlendConfig {
  const config = { ...DEFAULT_BLEND_CONFIG, ...override };
  if (!bot.useLLMPrior) return { ...config, mode: 'off' };
  return { ...config, mode: config.mode === 'off' ? 'prior' : config.mode };
}

/**
 * Combine search scores with an advisor assessment.
 * `off`, a missing assessment, or a degraded assessment leaves the search order unchanged.
 */
export function blendCandidates(
  candidates: AdvisorCandidate[],
  assessment: AdvisorAssessment | null,
  config: BlendConfig
): { ranked: RankedCandidate[]; source: BlendOutcome['source']; degraded: boolean } {
  const searchOrder = [...candidates].sort((a, b) => b.searchScore - a.searchScore);
  const advisorUnusable = !assessment || assessment.degraded;

  if (config.mode === 'off' || advisorUnusable) {
    return {
      source: 'search',
      degraded: config.mode !== 'off' && advisorUnusable,
      ranked: searchOrder.map(candidate => row(candidate, null, candidate.searchScore)),
    };
  }

  if (config.mode === 'tiebreaker') {
    const best = searchOrder[0]?.searchScore ?? 0;
    const ranked = searchOrder.map(candidate => {
      const probability = assessment.probabilities[candidate.id] ?? 0;
      const contender = best - candidate.searchScore <= config.tieEpsilon;
      const blendedScore = contender ? best + 1 + probability : candidate.searchScore;
      return row(candidate, assessment, blendedScore);
    });
    ranked.sort((a, b) => b.blendedScore - a.blendedScore);
    return { ranked, source: 'tiebreaker', degraded: false };
  }

  const normalized = minMax(searchOrder.map(candidate => candidate.searchScore));
  const weight = clampWeight(config.priorWeight);
  const ranked = searchOrder.map((candidate, index) => {
    const advisorScore = assessment.scores[candidate.id];
    const searchNorm = normalized[index];
    const blendedScore =
      advisorScore == null ? searchNorm : (1 - weight) * searchNorm + weight * advisorScore;
    return row(candidate, assessment, blendedScore);
  });
  ranked.sort((a, b) => b.blendedScore - a.blendedScore);
  return { ranked, source: 'prior', degraded: false };
}

export async function chooseAction(args: {
  state: GameState;
  legalActions: Action[];
  search: CandidateSearch;
  advisor?: JevAdvisor;
  config?: Partial<BlendConfig>;
}): Promise<BlendOutcome> {
  const config = { ...DEFAULT_BLEND_CONFIG, ...args.config };
  const fallback = args.legalActions[0] ?? { type: 'move' as const, moveIndex: 1 };
  const scored = await args.search.scoreActions(args.state, args.legalActions);
  if (scored.length === 0) {
    return { action: fallback, ranked: [], source: 'search', degraded: false };
  }

  const ordered = [...scored].sort((a, b) => b.searchScore - a.searchScore);
  if (config.mode === 'off' || !args.advisor) {
    const top = ordered[0];
    return {
      action: top.action,
      source: 'search',
      degraded: config.mode !== 'off',
      ranked: ordered.map(candidate => ({
        id: `${candidate.action.type}:${'moveIndex' in candidate.action ? candidate.action.moveIndex : candidate.action.switchIndex}`,
        action: candidate.action,
        searchScore: candidate.searchScore,
        advisorScore: null,
        advisorProbability: null,
        blendedScore: candidate.searchScore,
      })),
    };
  }

  let assessment: AdvisorAssessment;
  let candidates: AdvisorCandidate[];
  try {
    const advised = await args.advisor.adviseFromState(args.state, ordered, config.topK);
    assessment = advised.assessment;
    candidates = advised.candidates;
  } catch (error) {
    assessment = {
      model: 'typesafe-ai/jev',
      scores: {},
      probabilities: {},
      booleans: {},
      degraded: true,
      reason: error instanceof Error ? error.message : 'advisor_threw',
      latencyMs: 0,
      costUsd: 0,
    };
    candidates = ordered.slice(0, config.topK).map((candidate, index) => ({
      id: `a${index}`,
      label: `a${index}`,
      action: candidate.action,
      searchScore: candidate.searchScore,
    }));
  }

  const blended = blendCandidates(candidates, assessment, config);
  const winner = blended.ranked[0];
  return {
    action: winner?.action ?? fallback,
    ranked: blended.ranked,
    source: blended.source,
    degraded: blended.degraded,
  };
}

function row(candidate: AdvisorCandidate, assessment: AdvisorAssessment | null, blendedScore: number): RankedCandidate {
  return {
    id: candidate.id,
    action: candidate.action,
    searchScore: candidate.searchScore,
    advisorScore: assessment && !assessment.degraded ? assessment.scores[candidate.id] ?? null : null,
    advisorProbability: assessment && !assessment.degraded ? assessment.probabilities[candidate.id] ?? null : null,
    blendedScore,
  };
}

function minMax(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0.5);
  return values.map(value => (value - min) / (max - min));
}

function clampWeight(weight: number): number {
  if (weight < 0) return 0;
  if (weight > 1) return 1;
  return weight;
}
