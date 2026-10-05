import { legalChoices, safeChoose, startRandomBattle, teamsForSeed } from '../engine/exact/battle-utils.js';
import { EXACT_1PLY_QW, exactSearch } from '../engine/exact/search.js';
import { ladderDecisionBattle } from './hidden-info.js';

describe('decision battle tera availability', () => {
  it('does not offer terastallize after the live side has used Tera (even without quickWins)', () => {
    let checked = 0;
    for (let seed = 1; seed <= 40 && checked < 2; seed++) {
      const teams = teamsForSeed(seed);
      const battle = startRandomBattle(teams.p1, teams.p2, seed);
      if (battle.requestState === 'teampreview') {
        battle.choose('p1', 'default');
        battle.choose('p2', 'default');
      }
      let used = false;
      for (let turn = 0; turn < 30 && !battle.ended; turn++) {
        for (const side of ['p1', 'p2'] as const) {
          const legal = legalChoices(battle, side, { tera: true });
          if (legal.length === 0) continue;
          if (legal[0] === 'default') {
            battle.choose(side, 'default');
            continue;
          }
          const tera = legal.find(choice => choice.includes('terastallize'));
          safeChoose(battle, side, tera || legal.find(choice => choice.startsWith('move')) || legal[0]);
          if (tera) used = true;
        }
        if (!used || battle.ended) continue;
        for (const side of ['p1', 'p2'] as const) {
          const legal = legalChoices(battle, side, { tera: true });
          if (!legal.some(choice => choice.startsWith('move'))) continue;
          if (legal.some(choice => choice.includes('terastallize'))) continue;
          const viewed = ladderDecisionBattle(battle, side);
          expect(viewed).not.toBeNull();
          if (!viewed) continue;
          const viewedLegal = legalChoices(viewed, 'p1', { tera: true });
          expect(viewedLegal.some(choice => choice.includes('terastallize'))).toBe(false);
          const choice = exactSearch(viewed, 'p1', { ...EXACT_1PLY_QW, samples: 1 }).choice;
          expect(choice.includes('terastallize')).toBe(false);
          expect(legal.includes(choice) || choice === 'default').toBe(true);
          checked++;
        }
        break;
      }
    }
    expect(checked).toBeGreaterThan(0);
  }, 120_000);
});
