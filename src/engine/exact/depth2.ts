import type { Battle } from '@pkmn/sim';
import { SideId, legalChoices, snapshot } from './battle-utils.js';
import {
  exactSearch,
  scoreLine,
  transpositionStats,
  withTranspositions,
  type ExactConfig,
  type SearchTrace,
} from './search.js';

/**
 * Selective depth-2 search.
 *
 * Depth 1 scores every legal root move. While the deadline has time left,
 * the next-best of those moves is replaced by a depth-2 expectimax: that
 * move, the opponent's top-M replies, then our capped follow-up. Widening
 * stops at top-N. Damage rolls are grouped KO vs non-KO when rollGrouping
 * is 'ko'. One transposition table covers the decision.
 *
 * Sampled-world search calls exactSearch. A config with `selective` set
 * uses this search in every world. The config id `selective-depth2` builds
 * that same ExactConfig, which is also what the hybrid engine selects.
 */
export function selectiveDepth2(battle: Battle, side: SideId, config: ExactConfig): SearchTrace {
  const topN = Math.max(1, config.selective?.topN ?? 3);
  const topM = Math.max(1, config.selective?.topM ?? 2);
  const started = Date.now();
  const deadline = config.deadlineMs != null
    ? config.deadlineMs
    : config.budgetMs != null
      ? started + config.budgetMs
      : undefined;

  return withTranspositions(() => {
    const ordering: ExactConfig = {
      ...config,
      depth: 1,
      selective: undefined,
      deadlineMs: deadline,
      budgetMs: undefined,
    };
    const depth1 = exactSearch(battle, side, ordering);
    const stats = () => {
      const table = transpositionStats();
      return { cacheHits: table.hits, transpositionSize: table.size };
    };
    if (config.depth < 2 || depth1.scores.length <= 1 || (deadline != null && Date.now() >= deadline)) {
      return { ...depth1, depthReached: 1, ...stats() };
    }

    const ranked = [...depth1.scores].sort((a, b) => b.score - a.score || a.choice.localeCompare(b.choice));
    const scores = new Map(depth1.scores.map(row => [row.choice, row.score]));
    const snap = snapshot(battle);
    const deep: ExactConfig = {
      ...ordering,
      depth: 2,
      replyCap: topM,
      maxReplies: topM,
      rollGrouping: config.rollGrouping ?? 'ko',
      deeperChoices: config.deeperChoices ?? topN,
    };
    let deepened = 0;
    for (const row of ranked) {
      if (deepened >= topN) break;
      if (deadline != null && Date.now() >= deadline) break;
      const parts = scoreLine(snap, side, row.choice, 2, deep, 1, null, null);
      if (parts.played) scores.set(row.choice, parts.mean);
      deepened++;
    }

    const legal = legalChoices(battle, side);
    let best = depth1.choice;
    let bestScore = scores.get(best) ?? -Infinity;
    const listed: Array<{ choice: string; score: number }> = [];
    for (const choice of legal) {
      const score = scores.get(choice);
      if (score == null) continue;
      listed.push({ choice, score });
      if (score > bestScore) {
        bestScore = score;
        best = choice;
      }
    }
    return {
      choice: best,
      scores: listed.length ? listed : depth1.scores,
      predictedSwitch: depth1.predictedSwitch,
      answersPredictedSwitch: depth1.answersPredictedSwitch,
      depthReached: deepened > 0 ? 2 : 1,
      ...stats(),
    };
  });
}
