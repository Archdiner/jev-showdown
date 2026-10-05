import * as path from 'path';
import { buildBot } from '../config/bot.js';
import { analyzeLoss, generalizeFinding } from './analyst.js';

describe('analyst hypotheses', () => {
  it('replaces a position-specific finding with a mechanism or eval term', () => {
    const finding = generalizeFinding({
      criticalTurn: 3,
      mistakeClass: 'move-choice',
      summary: 'Garchomp should always use earthquake on this position',
      hypothesis: {
        title: 'Garchomp earthquake',
        rationale: 'always use earthquake',
        expectedEffect: 'win this position',
        testPlan: 'turn 3 switch to the same mon',
        killCondition: 'the one position still loses',
      },
    });
    const text = JSON.stringify(finding).toLowerCase();
    expect(text).not.toContain('garchomp');
    expect(text).not.toContain('earthquake');
    expect(finding.hypothesis.title).toBe('eval-term: hpDifference');
    expect(finding.hypothesis.testPlan).toMatch(/dev position set/);
    expect(finding.summary).toMatch(/eval term/);
  });

  it('does not call a model when the env disallows it', async () => {
    const bot = buildBot(path.join(process.cwd(), 'configs/champion.yaml'), 'selfplay');
    const result = await analyzeLoss(bot, 'a lost game log');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/llm_disabled_by_env/);
  });
});
