import type { EvaluateQuestion } from '../gateway-client.js';
import type { LegalOption } from '../context/types.js';
import type { CriteriaStyle, JevSoloConfig, QuestionDesign } from './config.js';

export const PLAIN_INSTRUCTION =
  'Choose the best legal action this turn using only the numbers and revealed facts in the state.';

export const PLANNER_INSTRUCTION =
  'Choose the action that best wins the game, not only this exchange. You may preserve a win condition, sack a Pokemon that has finished its job, or play for a predicted switch. Follow the decision lines: take a koNow=yes hit, switch when staying is the KO, and terastallize when flipsKO or flipsSurvival is yes. The switch prior is a base rate, not a quota. A hypothesis is a research note, not an order.';

export const ACTION_SCORE_LEVELS = ['blunder', 'poor', 'even', 'good', 'best'];
export const RISK_LEVELS = ['safe', 'manageable', 'risky', 'reckless'];
export const MATCHUP_LEVELS = ['losing', 'behind', 'even', 'ahead', 'winning'];

export const STRATEGY_CRITERIA: Record<string, string> = {
  press: 'attack the active Pokemon to make progress now',
  switch: 'switch to a better matchup or to keep a needed Pokemon healthy',
  sack: 'let the active Pokemon faint so the next one switches in safely',
  predict: 'choose a move that is still good if the opponent switches',
  tera: 'terastallize this turn',
  setup: 'boost, set a hazard, or use a status move',
};

export function actionInstruction(criteria: CriteriaStyle, guidanceOn: boolean): string {
  const base = criteria === 'planner' ? PLANNER_INSTRUCTION : PLAIN_INSTRUCTION;
  if (!guidanceOn) return base;
  return `${base} Apply a principle from the state only when the position matches it.`;
}

export function choiceQuestion(legal: LegalOption[], config: JevSoloConfig, guidanceOn: boolean): EvaluateQuestion {
  return {
    type: 'choice',
    instructions: actionInstruction(config.criteria, guidanceOn),
    criteria: Object.fromEntries(legal.map(option => [option.id, option.label])),
  };
}

export function questionsFor(
  design: QuestionDesign,
  legal: LegalOption[],
  config: JevSoloConfig,
  guidanceOn: boolean
): Record<string, EvaluateQuestion> {
  if (design === 'score') {
    const questions: Record<string, EvaluateQuestion> = {};
    for (const option of legal) {
      questions[option.id] = {
        type: 'score',
        instructions: `${actionInstruction(config.criteria, guidanceOn)} Action: ${option.label}`,
        criteria: ACTION_SCORE_LEVELS,
      };
    }
    return questions;
  }
  if (design === 'two-stage') {
    return {
      strategy: {
        type: 'choice',
        instructions: 'What is the plan for this turn? The action choice stays free over every legal option.',
        criteria: STRATEGY_CRITERIA,
      },
    };
  }
  if (design === 'multi') {
    const questions: Record<string, EvaluateQuestion> = {
      bestAction: choiceQuestion(legal, config, guidanceOn),
      opponentWillSwitch: {
        type: 'boolean',
        instructions:
          'Will the opponent hard-switch this turn? Use the switch prior and whether their active is threatened. This is a probability, not an order to switch.',
        criteria: { true: 'the opponent hard-switches', false: 'the opponent stays in' },
      },
      matchup: {
        type: 'score',
        instructions: 'How favorable is the current active matchup, using the damage numbers in the state?',
        criteria: MATCHUP_LEVELS,
      },
    };
    for (const option of legal) {
      questions[`risk_${option.id}`] = {
        type: 'score',
        instructions: `How much win-chance does this action risk: ${option.label}?`,
        criteria: RISK_LEVELS,
      };
    }
    return questions;
  }
  return { bestAction: choiceQuestion(legal, config, guidanceOn) };
}
